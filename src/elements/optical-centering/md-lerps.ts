// "One .to(), every type" — showcase for minim's generalized tween
// engine. The struct framework registers a `lerp` op for value types
// (Vec, AABB, Color, …); `Signal.prototype.to` looks it up via a
// hidden prototype slot and dispatches. Adding a new value type
// (with a `lerp`) gets you `.to()` for free, no engine changes.
//
// Five rows — each animates a different value type. They all run
// simultaneously via the same `.to()` call shape:
//
//   yield [
//     num.to(0.85, 0.6),
//     pos.to({ x: 220, y: 0 }, 0.6),
//     box.to({ x: 60, y: 0, w: 60, h: 36 }, 0.6),
//     col.to({ r: 0.95, g: 0.4, b: 0.2, a: 1 }, 0.6),
//     txt.to("goodbye", 0.6),
//   ]
//
// Strings don't fit the Schema (which is `Record<string, number |
// StructType>`), so they use `lerpable(initial, lerp)` — a tiny
// helper that stamps the same `[LERP]` slot on a plain Signal.

import {
  Anchor,
  Color,
  Diagram,
  Scene,
  Vec,
  computed,
  label,
  lerpable,
  pt,
  rect,
  signal,
  type Content,
  type Lerp,
} from "../../minim";
// AABB is exported as a *type* from minim's surface (the `type AABB`
// from scene/box). The reactive struct value lives in signals/aabb;
// import it directly here to access `.signal(...)` for this demo.
import { AABB } from "../../minim/signals/aabb";

const W = 640;
const H = 320;
const ROW_H = 50;
const TOP = 50;
const LABEL_X = 24;
const VIS_X = 110;
const VIS_W = 220;
const READ_X = VIS_X + VIS_W + 24;
const DUR = 0.7;
const DWELL = 0.45;

/** Shrink-then-grow string lerp. Visible length goes
 *  `a.length → 0 → b.length` over `t ∈ [0, 1]`; the source switches
 *  at the midpoint, so the text reads as "type out, then type in". */
const stringLerp: Lerp<string> = (a, b, t) => {
  if (t <= 0.5) {
    const k = 1 - t * 2;
    return a.slice(0, Math.round(a.length * k));
  }
  const k = (t - 0.5) * 2;
  return b.slice(0, Math.round(b.length * k));
};

const fmtNum = (n: number) => n.toFixed(2);
const fmtVec = (v: { x: number; y: number }) =>
  `(${Math.round(v.x)}, ${Math.round(v.y)})`;
const fmtBox = (b: { x: number; y: number; w: number; h: number }) =>
  `${Math.round(b.w)}×${Math.round(b.h)}`;
const fmtColor = (c: { r: number; g: number; b: number; a: number }) =>
  `#${[c.r, c.g, c.b]
    .map((x) =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

export class MdLerps extends Diagram {
  protected scene(s: Scene): void {
    const view = s.view(W, H);

    s(
      label(view.top.down(22), "one .to(), every value type", {
        size: 13,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(20),
        "Signal.prototype.to dispatches via [LERP] on the prototype chain — Vec, AABB, Color all register their own; lerpable(...) wires it for arbitrary types.",
        { size: 10, align: Anchor.Center, opacity: 0.45 },
      ),
    );

    // ── Row 1: number ──────────────────────────────────────────────
    {
      const y = TOP;
      const num = signal(0.15);
      s(
        label(pt(LABEL_X, y + 9), "number", {
          size: 11,
          align: Anchor.Left,
          opacity: 0.7,
        }),
        // Track.
        rect(VIS_X, y + 4, VIS_W, 10, {
          stroke: "transparent",
          fill: "rgba(127,127,127,0.18)",
        }),
        // Fill bar — reactive width via computed.
        rect(
          VIS_X,
          y + 4,
          computed(() => num.value * VIS_W),
          10,
          { stroke: "transparent", fill: true },
        ),
        label(pt(READ_X, y + 9), num.derive(fmtNum), {
          size: 11,
          align: Anchor.Left,
          opacity: 0.65,
        }),
      );
      this.numState = num;
    }

    // ── Row 2: Vec (Reactive<V>) ───────────────────────────────────
    {
      const y = TOP + ROW_H;
      const pos = Vec.signal({ x: VIS_X + 12, y: y + 9 });
      s(
        label(pt(LABEL_X, y + 9), "Vec", {
          size: 11,
          align: Anchor.Left,
          opacity: 0.7,
        }),
        rect(VIS_X, y + 5, VIS_W, 8, {
          stroke: "transparent",
          fill: "rgba(127,127,127,0.10)",
          corner: 4,
        }),
        // The dot — its center IS the Vec signal.
        rect(pos.x.derive((x) => x - 5), pos.y.derive((y) => y - 5), 10, 10, {
          stroke: "transparent",
          fill: true,
          corner: 5,
        }),
        label(pt(READ_X, y + 9), pos.derive(fmtVec), {
          size: 11,
          align: Anchor.Left,
          opacity: 0.65,
        }),
      );
      this.vecState = { pos, baseY: y + 9 };
    }

    // ── Row 3: AABB (Reactive<A>) ──────────────────────────────────
    {
      const y = TOP + ROW_H * 2;
      // `AABB.signal(...)` returns a `Reactive<A>` with the same
      // `.to` surface as Vec/Color — all built on the same struct
      // framework.
      const box = AABB.signal({ x: VIS_X + 4, y: y - 6, w: 30, h: 20 });
      s(
        label(pt(LABEL_X, y + 9), "AABB", {
          size: 11,
          align: Anchor.Left,
          opacity: 0.7,
        }),
        rect(VIS_X, y - 14, VIS_W, 36, {
          stroke: "transparent",
          fill: "rgba(127,127,127,0.10)",
          corner: 4,
        }),
        // Every axis (x, y, w, h) is a Signal<number> lens projection;
        // .to() drives all four through AABB.lerp.
        rect(box.x, box.y, box.w, box.h, {
          stroke: "transparent",
          fill: true,
          corner: 3,
        }),
        label(pt(READ_X, y + 9), box.derive(fmtBox), {
          size: 11,
          align: Anchor.Left,
          opacity: 0.65,
        }),
      );
      this.boxState = { box, baseY: y };
    }

    // ── Row 4: Color (Reactive<C>) ─────────────────────────────────
    {
      const y = TOP + ROW_H * 3;
      const col = Color.signal({ r: 0.4, g: 0.6, b: 0.9, a: 1 });
      // `col.css` is a *lifted* scalar — a `() => ReadonlySignal<string>`
      // factory. Call once; subsequent renders share one signal.
      const cssSig = col.css();
      s(
        label(pt(LABEL_X, y + 9), "Color", {
          size: 11,
          align: Anchor.Left,
          opacity: 0.7,
        }),
        rect(VIS_X, y - 6, VIS_W, 22, {
          stroke: "transparent",
          fill: cssSig,
          corner: 3,
        }),
        label(pt(READ_X, y + 9), col.derive(fmtColor), {
          size: 11,
          align: Anchor.Left,
          opacity: 0.65,
        }),
      );
      this.colorState = col;
    }

    // ── Row 5: string (Signal<string> + lerpable) ──────────────────
    {
      const y = TOP + ROW_H * 4;
      // String isn't a struct value type (Schema is Record<string,
      // number | StructType>); `lerpable` stamps the same prototype
      // [LERP] slot the struct framework uses, so .to() Just Works.
      const txt = lerpable("hello", stringLerp);
      s(
        label(pt(LABEL_X, y + 9), "string", {
          size: 11,
          align: Anchor.Left,
          opacity: 0.7,
        }),
        rect(VIS_X, y - 6, VIS_W, 22, {
          stroke: "transparent",
          fill: "rgba(127,127,127,0.08)",
          corner: 3,
        }),
        label(pt(VIS_X + 10, y + 9), txt as unknown as Content, {
          size: 13,
          align: Anchor.Left,
        }),
        label(
          pt(READ_X, y + 9),
          txt.derive((s) => `len=${s.length}`),
          { size: 11, align: Anchor.Left, opacity: 0.65 },
        ),
      );
      this.strState = txt;
    }

    // ── Drive ──────────────────────────────────────────────────────
    const num = this.numState;
    const { pos, baseY: vBaseY } = this.vecState;
    const { box, baseY: bBaseY } = this.boxState;
    const col = this.colorState;
    const txt = this.strState;

    // Three keyframes per row. Each pair of consecutive frames runs
    // as ONE parallel batch — `yield [a.to(...), b.to(...), …]` —
    // exercising the same generic engine across every value type.
    const FRAMES = [
      {
        n: 0.85,
        v: { x: VIS_X + VIS_W - 12, y: vBaseY },
        b: { x: VIS_X + VIS_W - 90, y: bBaseY - 10, w: 80, h: 26 },
        c: { r: 0.95, g: 0.45, b: 0.2, a: 1 },
        t: "morphing",
      },
      {
        n: 0.5,
        v: { x: VIS_X + VIS_W / 2, y: vBaseY },
        b: { x: VIS_X + VIS_W / 2 - 25, y: bBaseY - 4, w: 50, h: 16 },
        c: { r: 0.36, g: 0.78, b: 0.45, a: 1 },
        t: "between",
      },
      {
        n: 0.15,
        v: { x: VIS_X + 12, y: vBaseY },
        b: { x: VIS_X + 4, y: bBaseY - 6, w: 30, h: 20 },
        c: { r: 0.4, g: 0.6, b: 0.9, a: 1 },
        t: "hello",
      },
    ];

    this.anim.loop(function* () {
      for (const f of FRAMES) {
        // The punchline: identical .to(target, dur) shape across
        // five completely different value types. All five are tweens
        // through the same `tweenStep` function in `core/tween.ts`.
        yield [
          num.to(f.n, DUR),
          pos.to(f.v, DUR),
          box.to(f.b, DUR),
          col.to(f.c, DUR),
          txt.to(f.t, DUR),
        ];
        yield DWELL;
      }
    });
  }

  // Per-row state, declared up here so the loop closure can reach it
  // without nested-scope juggling.
  private numState!: ReturnType<typeof signal<number>>;
  private vecState!: { pos: ReturnType<typeof Vec.signal>; baseY: number };
  private boxState!: { box: ReturnType<typeof AABB.signal>; baseY: number };
  private colorState!: ReturnType<typeof Color.signal>;
  private strState!: ReturnType<typeof lerpable<string>>;
}
