// md-merge.ts — `cell.merge(policy)`: the backward dual of a computed.
//
// A `merge` cell is forward-transparent (the identity view of one source)
// but backward-aggregating: N independent contributors each push a value,
// slot-keyed by identity, and a monoid policy folds them into the single
// source. It's the principled answer to the "diamond" — several lenses
// reconverging on one source in the same settle combine instead of
// clobbering — and the fold is order-independent.
//
// Four policies, one mechanism. Each panel wires 3 contributor lenses
// into one `target.merge(policy)` and reads back the folded source:
//
//   ∩  intersection      meet of intervals      idempotent, no inverse
//   ⊔  last-writer-wins   max by logical clock   a join (lattice top)
//   ∨  wired bus          tri-state resolution   idempotent + conflict
//   Σ  Bayesian fusion    sum of log-odds        a group, has `remove`
//
// Contributor wiring: a merge folds the contributions made within one
// propagation settle, then resets. So an `effect` re-asserts every
// contributor in a single `batch` whenever any proposal changes — all N
// land together and the fold sees the full set. Distinct slot identities
// need distinct lenses (a direct write shares one `DIRECT_SLOT`), so each
// contributor is its own identity lens on the merge cell.

import {
  Anchor,
  batch,
  type Cell,
  cell,
  circle,
  derive,
  Diagram,
  drag,
  effect,
  label,
  line,
  type Mount,
  Num,
  num,
  range,
  rect,
  tokens,
  Vec,
  vec,
  type Writable,
} from "../../minim";

const W = 640;
const H = 512;
const X0 = 40;
const X1 = 440;
const SPAN = X1 - X0;
const RX = 470; // left edge of the right-hand readout column
const PH = 118; // panel height
const COLORS = ["#5b8def", "#e25c5c", "#f5a623"] as const;

type Iv = { lo: number; hi: number };
type Reg = { ts: number; v: number; who: number };
type Bus = "Z" | "0" | "1" | "X";

const BUS_COLOR: Record<Bus, string> = {
  Z: "#999",
  "0": "#5b8def",
  "1": "#7ed321",
  X: "#e25c5c",
};

/** Z is identity; agreeing drivers pass through; disagreement is `X`. */
const busCombine = (a: Bus, b: Bus): Bus => {
  if (a === "Z") return b;
  if (b === "Z") return a;
  if (a === "X" || b === "X") return "X";
  return a === b ? a : "X";
};

interface Policy<T> {
  identity: T;
  combine: (acc: T, x: T) => T;
  remove?: (acc: T, x: T) => T;
}

/** Fold N reactive `proposals` into one source via `cell.merge(policy)`,
 *  re-asserting every contributor each settle so the fold sees the full
 *  set. Returns the folded source (read its `.value`). */
function mergeOf<T>(policy: Policy<T>, proposals: readonly Cell<T>[], equals?: (a: T, b: T) => boolean): Cell<T> {
  const target = cell<T>(policy.identity, equals ? { equals } : undefined);
  const m = target.merge(policy) as Writable<Cell<T>>;
  const ports = proposals.map(() => m.lens(v => v, n => n));
  effect(() => {
    const vals = proposals.map(p => p.value);
    batch(() => {
      ports.forEach((port, i) => {
        port.value = vals[i]!;
      });
    });
  });
  return target;
}

export class MdMerge extends Diagram {
  protected scene(s: Mount): void {
    this.view(W, H);
    s(
      label(vec(X0, 16), "merge() — one source, many backward contributors, four fold policies", {
        align: Anchor.Left,
        size: 12,
        bold: true,
      }),
    );
    this.panelInterval(36);
    this.panelLww(154);
    this.panelBus(272);
    this.panelBayes(390);
    s(
      label(vec(X0, H - 6), "drag any knob — contributors fold into one source, order-independent", {
        align: Anchor.Left,
        size: 9.5,
        opacity: 0.55,
      }),
    );
  }

  // ── ∩  intersection — meet of intervals (idempotent, no inverse) ─────
  private panelInterval(py: number): void {
    const s = this.s;
    const railY = py + 52;
    const HALF = 52;
    const cxs = COLORS.map((_, i) => range(X0 + HALF, X1 - HALF).slider(num(0.4 + i * 0.1)));
    const proposals = cxs.map(cx => derive((): Iv => ({ lo: cx.value - HALF, hi: cx.value + HALF })));
    const meet = mergeOf<Iv>(
      {
        identity: { lo: -1e9, hi: 1e9 },
        combine: (a, b) => ({ lo: Math.max(a.lo, b.lo), hi: Math.min(a.hi, b.hi) }),
      },
      proposals,
      (a, b) => a.lo === b.lo && a.hi === b.hi,
    );
    const empty = derive(() => meet.value.lo > meet.value.hi);

    s(
      rect(
        derive(() => meet.value.lo),
        railY - 24,
        derive(() => Math.max(0, meet.value.hi - meet.value.lo)),
        56,
        { fill: "rgba(126,211,33,0.16)", stroke: "#3a3", strokeWidth: 1.2 },
      ),
    );
    cxs.forEach((cx, i) => {
      const y = railY - 16 + i * 16;
      s(
        rect(
          derive(() => cx.value - HALF),
          y - 3,
          HALF * 2,
          6,
          { fill: COLORS[i]!, opacity: 0.28, stroke: "none" },
        ),
      );
      this.knob(cx, y, COLORS[i]!);
    });

    this.frame(py, "∩", "intersection — 3 interval constraints", "feasible = ⋂ constraints · idempotent meet, no inverse");
    s(
      label(
        vec(RX, railY),
        derive(() => (empty.value ? "∅ empty" : `[${Math.round(meet.value.lo)}, ${Math.round(meet.value.hi)}]`)),
        { align: Anchor.Left, size: 12, bold: true, fill: derive(() => (empty.value ? "#e25c5c" : "#3a3")) },
      ),
    );
  }

  // ── ⊔  last-writer-wins register — max by logical clock (a join) ─────
  private panelLww(py: number): void {
    const s = this.s;
    const railY = py + 52;
    let clock = COLORS.length - 1;
    s(line(vec(X0, railY), vec(X1, railY), { thin: true, opacity: 0.3 }));

    const proposals = COLORS.map((color, i) => {
      const t = num(0.22 + i * 0.26);
      const ts = num(i);
      const slider = range(X0, X1).slider(t);
      const k = this.knob(slider, railY, color);
      k.on("pointerdown", () => {
        clock += 1;
        ts.value = clock;
      });
      return derive((): Reg => ({ ts: ts.value, v: t.value, who: i }));
    });
    const reg = mergeOf<Reg>(
      { identity: { ts: -1, v: 0.5, who: -1 }, combine: (a, b) => (b.ts > a.ts ? b : a) },
      proposals,
      (a, b) => a.ts === b.ts && a.v === b.v && a.who === b.who,
    );

    s(
      circle(Vec.derive(() => ({ x: X0 + reg.value.v * SPAN, y: railY })), 12, {
        fill: derive(() => (reg.value.who >= 0 ? COLORS[reg.value.who]! : "#999")),
        opacity: 0.3,
        stroke: "none",
      }),
    );
    this.frame(py, "⊔", "last-writer-wins register", "max by logical clock · grabbing a knob = that replica writes");
    s(
      label(
        vec(RX, railY),
        derive(() => (reg.value.who >= 0 ? `replica ${reg.value.who + 1} · t=${reg.value.ts}` : "—")),
        {
          align: Anchor.Left,
          size: 11,
          bold: true,
          fill: derive(() => (reg.value.who >= 0 ? COLORS[reg.value.who]! : "#999")),
        },
      ),
    );
  }

  // ── ∨  wired bus — tri-state resolution (idempotent + conflict) ──────
  private panelBus(py: number): void {
    const s = this.s;
    const railY = py + 50;
    (["Z", "0", "1"] as const).forEach((lab, z) => {
      s(label(vec(X0 + ((z + 0.5) / 3) * SPAN, railY - 22), lab, { size: 9, opacity: 0.4 }));
      if (z > 0) {
        const xz = X0 + (z / 3) * SPAN;
        s(line(vec(xz, railY - 14), vec(xz, railY + 10), { thin: true, opacity: 0.15 }));
      }
    });
    s(line(vec(X0, railY), vec(X1, railY), { thin: true, opacity: 0.3 }));

    const proposals = COLORS.map((color, i) => {
      const t = num([0.16, 0.5, 0.84][i]!);
      const slider = range(X0, X1).slider(t);
      this.knob(slider, railY, color);
      return derive((): Bus => {
        const x = t.value;
        return x < 1 / 3 ? "Z" : x < 2 / 3 ? "0" : "1";
      });
    });
    const bus = mergeOf<Bus>({ identity: "Z", combine: busCombine }, proposals);
    const col = derive(() => BUS_COLOR[bus.value]);

    s(line(vec(X0, railY + 20), vec(X1, railY + 20), { strokeWidth: 4, cap: "round", stroke: col }));
    this.frame(py, "∨", "wired bus (tri-state)", "Z floats · 0/1 drive · two drivers disagree ⇒ X conflict");
    s(
      label(
        vec(RX, railY),
        derive(() => (bus.value === "X" ? "X conflict" : bus.value === "Z" ? "floating" : `drives ${bus.value}`)),
        { align: Anchor.Left, size: 12, bold: true, fill: col },
      ),
    );
  }

  // ── Σ  Bayesian fusion — sum of log-odds (a group, has remove) ───────
  private panelBayes(py: number): void {
    const s = this.s;
    const railY = py + 46;
    s(line(vec(X0, railY), vec(X1, railY), { thin: true, opacity: 0.3 }));
    s(line(vec(X0 + SPAN / 2, railY - 12), vec(X0 + SPAN / 2, railY + 12), { thin: true, opacity: 0.15 }));

    const proposals = COLORS.map((color, i) => {
      const t = num(0.5 + (i - 1) * 0.12);
      const slider = range(X0, X1).slider(t);
      this.knob(slider, railY, color);
      return derive(() => (t.value - 0.5) * 6);
    });
    const sum = mergeOf<number>({ identity: 0, combine: (a, b) => a + b, remove: (a, b) => a - b }, proposals);
    const p = derive(() => 1 / (1 + Math.exp(-sum.value)));

    const barY = railY + 22;
    s(rect(X0, barY, SPAN, 10, { fill: "none", stroke: tokens.stroke, strokeWidth: 1, opacity: 0.3 }));
    s(
      rect(
        X0,
        barY,
        derive(() => p.value * SPAN),
        10,
        { fill: "#9b59d0", stroke: "none" },
      ),
    );
    this.frame(py, "Σ", "Bayesian fusion (log-odds)", "evidence adds in log-odds · has an inverse ⇒ incremental");
    s(
      label(vec(RX, railY), derive(() => `p = ${(p.value * 100).toFixed(0)}%`), {
        align: Anchor.Left,
        size: 12,
        bold: true,
        fill: "#9b59d0",
      }),
    );
  }

  /** Panel title (symbol + name), caption, and a top divider. */
  private frame(py: number, sym: string, name: string, caption: string): void {
    const s = this.s;
    if (py > 40) s(line(vec(0, py), vec(W, py), { thin: true, opacity: 0.15 }));
    s(label(vec(X0, py + 14), `${sym}  ${name}`, { align: Anchor.Left, size: 12, bold: true }));
    s(label(vec(X0, py + 102), caption, { align: Anchor.Left, size: 9.5, opacity: 0.55 }));
  }

  /** Draggable knob pinned to a horizontal rail at `y`. */
  private knob(slider: Writable<Num>, y: number, color: string) {
    const pos = vec(slider, Num.pin(y));
    const k = this.s(circle(pos, 7, { fill: color, stroke: "white", strokeWidth: 2 }));
    drag(k, pos);
    k.el.style.cursor = "ew-resize";
    return k;
  }
}
