// Non-linear topology driven by an event bus. Read top-to-bottom:
// helpers → nodes → wires → behavior. Two parallel topologies share
// the bus:
//
//   A ─┐
//      AND ── DELAY ── SPLIT ─┬─ X       (sync + held + fan-out)
//   B ─┘                      └─ Y
//
//   C ─── CHOICE ─┬─ Z                   (random one-of branch)
//                 └─ W

import {
  Diagram,
  EventBus,
  Mount,
  type AnyShape,
  type Arg,
  type Path,
  type Pointlike,
  cell,
  circle,
  counter,
  label,
  linear,
  path,
  pt,
  rect,
  toSig,
  tokens,
} from "../../minim";
import * as R from "../rand";

export class MdCircuit extends Diagram {
  protected scene(s: Mount): void {
    this.view(600, 360);
    const anim = this.anim;
    const bus = new EventBus();

    // ── Visual primitives ───────────────────────────────────────────

    /** Circle + label that scale-pulses on `ev`. */
    const source = (x: number, y: number, lbl: string, ev: string) => {
      const c = circle(pt(x, y), 18);
      s(c, label(c.center, lbl, { size: 13, bold: true }));
      anim.loop(function* () {
        yield bus.until(ev);
        yield* c.scale.to({ x: 1.4, y: 1.4 }, 0.08).to({ x: 1, y: 1 }, 0.3);
      });
      return c;
    };

    /** Counting sink — live count + scale-pulse on each fire. */
    const sink = (x: number, y: number, lbl: string, ev: string) => {
      const c = circle(pt(x, y), 18);
      s(
        c,
        label(
          c.center,
          counter((cb) => bus.on(ev, () => cb())).derive(String),
          {
            size: 13,
            bold: true,
          },
        ),
        label(c.center.up(30), lbl, { size: 11, opacity: 0.7 }),
      );
      anim.loop(function* () {
        yield bus.until(ev);
        yield* c.scale.to({ x: 1.3, y: 1.3 }, 0.06).to({ x: 1, y: 1 }, 0.3);
      });
      return c;
    };

    /** Boxed gate — rectangle + title. `lblY` shifts the title
     *  (negative = up) to make room for indicator dots. */
    const box = (
      x: number,
      y: number,
      w: number,
      h: number,
      lbl: string,
      lblY = 0,
    ) => {
      const r = rect(pt(x, y), w, h);
      s(
        r,
        label(r.center.offset(0, lblY), lbl, { size: 10, opacity: 0.7 }),
      );
      return r;
    };

    /** Junction circle. */
    const node = (x: number, y: number) => {
      const c = circle(pt(x, y), 9);
      s(c);
      return c;
    };

    /** Indicator dot toggled by a reactive boolean. */
    const lit = (at: Pointlike, on: Arg<boolean>) =>
      circle(at, 4, {
        fill: toSig(on).derive((v) => (v ? tokens.stroke : "transparent")),
      });

    // Reactive auto-route — endpoints track visual boundaries as
    // shapes pulse:
    //   1. y-midline between source/target reference points
    //   2. P_A on the midline at 45° from source
    //   3. P_B symmetric to target
    //   4. path: src → P_A → P_B → tgt
    //
    // Refs default to each shape's `center`; pass an explicit Point
    // (e.g. `AND.left`) to anchor a specific edge.
    const wire = (
      a: AnyShape,
      b: AnyShape,
      opts: { from?: Pointlike; to?: Pointlike } = {},
    ) => {
      const aRef = opts.from ?? a.center;
      const bRef = opts.to ?? b.center;
      const aRefV = aRef.value;
      const bRefV = bRef.value;
      let w: Path;
      if (aRefV.x === bRefV.x || aRefV.y === bRefV.y) {
        const start = opts.from ?? a.boundary(bRef);
        const end = opts.to ?? b.boundary(aRef);
        w = path(start).to(end);
      } else {
        // 45° staircase: bend points sit on the y-midline where each
        // diagonal leg covers exactly |dy|/2 horizontally.
        const m = aRef.lerp(bRef, 0.5);
        const dirX = bRefV.x > aRefV.x ? 1 : -1;
        const halfDy = cell.derived(() => Math.abs(m.y.value - aRef.y.value));
        const pA = pt(() => aRef.x.value + dirX * halfDy.value, m.y);
        const pB = pt(() => bRef.x.value - dirX * halfDy.value, m.y);
        const start = opts.from ?? a.boundary(pA);
        const end = opts.to ?? b.boundary(pB);
        w = path(start).to(pA).to(pB).to(end);
      }
      w.opacity.value = 0.25;
      s(w);
      return w;
    };

    /** Constant spatial speed (px/sec) — longer wires take longer. */
    const SPEED = 240;

    /** Send one pulse along `w`; the wire's opacity flashes in lockstep. */
    const pulse = (w: Path, onArrive?: () => void) => {
      const total = w.length.value;
      const sec = total / SPEED;
      const dist = cell(0);
      const dot = circle(w.atDistance(dist), 5, { fill: true });
      s(dot);
      anim.run(function* () {
        yield* dist.to(total, sec, linear);
        dot.dispose();
        onArrive?.();
      });
      anim.run(function* () {
        yield* w.opacity.to(0.75, sec * 0.3).to(0.25, sec * 0.7);
      });
    };

    // ── Behavior helpers ────────────────────────────────────────────

    /** Fire `ev` at random intervals. */
    const ticker = (ev: string, minGap: number, maxGap: number) =>
      anim.run(function* () {
        yield R.float(0.3, minGap);
        while (true) {
          bus.emit(ev);
          yield R.float(minGap, maxGap);
        }
      });

    /** On `from`, send a pulse along `w`; on arrival fire `to`. */
    const relay = (from: string, w: Path, to: string) =>
      bus.on(from, () => pulse(w, () => bus.emit(to)));

    /** AND-sync: tokens accumulate from `evA`/`evB`; when each has ≥1,
     *  fire `out` and consume one of each. Slot-dot visuals derive
     *  from the counts (no manual mirroring). */
    const andSync = (evA: string, evB: string, out: string, gate: AnyShape) => {
      const a = cell(0);
      const b = cell(0);
      gate.add(
        lit(gate.center.offset(-14, 14), () => a.value > 0),
        lit(gate.center.offset(+14, 14), () => b.value > 0),
      );

      const settle = () => {
        const n = Math.min(a.peek(), b.peek());
        a.value -= n;
        b.value -= n;
        for (let i = 0; i < n; i++) bus.emit(out);
      };
      bus.on(evA, () => {
        a.value++;
        settle();
      });
      bus.on(evB, () => {
        b.value++;
        settle();
      });
    };

    /** Hold an arriving event for a random interval, then relay. */
    const hold = (
      from: string,
      holdRange: [number, number],
      w: Path,
      out: string,
      gate: AnyShape,
    ) => {
      const holding = cell(false);
      gate.add(lit(gate.center.down(6), holding));
      anim.loop(function* () {
        yield bus.until(from);
        holding.value = true;
        yield R.float(holdRange[0], holdRange[1]);
        holding.value = false;
        pulse(w, () => bus.emit(out));
      });
    };

    /** Fan one input into N parallel pulses. */
    const split = (from: string, branches: [Path, string][]) =>
      bus.on(from, () => {
        for (const [w, out] of branches) pulse(w, () => bus.emit(out));
      });

    /** Fan one input into ONE randomly-picked branch. */
    const choose = (from: string, branches: [Path, string][]) =>
      bus.on(from, () => {
        const [w, out] = R.pick(branches);
        pulse(w, () => bus.emit(out));
      });

    // ── Nodes ───────────────────────────────────────────────────────
    const A = source(50, 70, "A", "fire:A");
    const B = source(50, 170, "B", "fire:B");
    const AND = box(200, 120, 60, 48, "AND");
    const DELAY = box(310, 120, 50, 36, "DELAY", -6);
    const SPLIT = node(410, 120);
    s(label(SPLIT.center.up(24), "split", { size: 9, opacity: 0.6 }));
    const X = sink(560, 70, "X", "arrived:X");
    const Y = sink(560, 170, "Y", "arrived:Y");

    const C = source(50, 290, "C", "fire:C");
    const CHOICE = box(270, 290, 60, 40, "CHOICE");
    const Z = sink(560, 250, "Z", "arrived:Z");
    const W_ = sink(560, 330, "W", "arrived:W");

    // ── Wires ───────────────────────────────────────────────────────
    // Anchor AND inputs to AND.left and CHOICE outputs to CHOICE.right
    // so the 45° staircase lands cleanly on a shared edge.
    const wA = wire(A, AND, { to: AND.left });
    const wB = wire(B, AND, { to: AND.left });
    const wAD = wire(AND, DELAY);
    const wDS = wire(DELAY, SPLIT);
    const wSX = wire(SPLIT, X);
    const wSY = wire(SPLIT, Y);
    const wCC = wire(C, CHOICE);
    const wCZ = wire(CHOICE, Z, { from: CHOICE.right });
    const wCW = wire(CHOICE, W_, { from: CHOICE.right });

    // ── Behavior ────────────────────────────────────────────────────
    ticker("fire:A", 1.4, 2.6);
    ticker("fire:B", 1.0, 2.2);
    ticker("fire:C", 0.9, 1.8);

    relay("fire:A", wA, "arrived:and:A");
    relay("fire:B", wB, "arrived:and:B");
    relay("fire:C", wCC, "arrived:choice");

    andSync("arrived:and:A", "arrived:and:B", "and:fire", AND);
    relay("and:fire", wAD, "delay:enter");
    hold("delay:enter", [0.3, 0.6], wDS, "split:enter", DELAY);
    split("split:enter", [
      [wSX, "arrived:X"],
      [wSY, "arrived:Y"],
    ]);

    choose("arrived:choice", [
      [wCZ, "arrived:Z"],
      [wCW, "arrived:W"],
    ]);
  }
}
