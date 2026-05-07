// Circuit — non-linear topology with multiple gate kinds, driven by
// minim's event bus. Read top-to-bottom: helpers, then nodes, then
// wires, then behaviors. The diagram's shape should be legible from
// the structure of `scene()` alone.
//
// Two parallel topologies sharing the bus:
//
//   A ─┐
//      AND ── DELAY ── SPLIT ─┬─ X       (sync + held + parallel fan-out)
//   B ─┘                      └─ Y
//
//   C ─── CHOICE ─┬─ Z                   (random one-of branch)
//                 └─ W

import {
  Diagram,
  Scene,
  type AnyShape,
  type Arg,
  type Path,
  type Point,
  circle,
  computed,
  css,
  label,
  linear,
  path,
  pt,
  rect,
  signal,
  store,
  toSig,
  tokens,
} from "../../minim";
import * as R from "../rand";

export class MdCircuit extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 660px;
    }
  `;

  protected scene(s: Scene): void {
    s.view(0, 0, 600, 360);
    const anim = this.anim;
    const bus = this.bus;

    // ── Visual primitives ───────────────────────────────────────────

    /** A source — circle + label, scale-pulses on each fire. */
    const source = (x: number, y: number, lbl: string, ev: string) => {
      const c = circle(pt(x, y), 18);
      s(c, label(c.center, lbl, { size: 13, bold: true }));
      anim.loop(function* () {
        yield* bus.until(ev);
        yield* c.scale.to({ x: 1.4, y: 1.4 }, 0.08).to({ x: 1, y: 1 }, 0.3);
      });
      return c;
    };

    /** A counting sink — circle showing live count, increments + scale- */
    const sink = (x: number, y: number, lbl: string, ev: string) => {
      const c = circle(pt(x, y), 18);
      s(
        c,
        label(
          c.center,
          bus.onSignal(ev).derive((e) => String(e.count)),
          {
            size: 13,
            bold: true,
          },
        ),
        label(c.center.up(30), lbl, { size: 11, opacity: 0.7 }),
      );
      anim.loop(function* () {
        yield* bus.until(ev);
        yield* c.scale.to({ x: 1.3, y: 1.3 }, 0.06).to({ x: 1, y: 1 }, 0.3);
      });
      return c;
    };

    /** A boxed gate — rectangle centered on (x,y) with a title. `lblY`
     *  shifts the title vertically (negative = up); useful when an
     *  indicator dot needs to sit below the title without crowding. */
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
        label(r.bounds.center.offset(0, lblY), lbl, { size: 10, opacity: 0.7 }),
      );
      return r;
    };

    /** A small junction circle — branch point. */
    const node = (x: number, y: number) => {
      const c = circle(pt(x, y), 9);
      s(c);
      return c;
    };

    /** Indicator dot whose fill toggles with a reactive boolean. */
    const lit = (at: Point, on: Arg<boolean>) =>
      circle(at, 4, {
        fill: toSig(on).derive((v) => (v ? tokens.stroke : "transparent")),
      });

    // Auto-route, fully reactive so endpoints stick to the visual
    // boundary as shapes pulse:
    //
    //   1. Find the y-midline between the source/target reference points.
    //   2. Place P_A on the midline at 45° from the source point.
    //   3. Place P_B symmetrically at 45° from the target point.
    //   4. Path: src → P_A → P_B → tgt.
    //
    // The reference points (`from`/`to`) default to each shape's bounds
    // center, in which case `src`/`tgt` resolve to the analytic boundary
    // along the 45° ray. Pass an explicit Point (e.g. `AND.bounds.left`)
    // to anchor the wire to a specific edge of the shape.
    const wire = (
      a: AnyShape,
      b: AnyShape,
      opts: { from?: Point; to?: Point } = {},
    ) => {
      const aRef = opts.from ?? a.bounds.center;
      const bRef = opts.to ?? b.bounds.center;
      const aRefV = aRef.value;
      const bRefV = bRef.value;
      let w: Path;
      if (aRefV.x === bRefV.x || aRefV.y === bRefV.y) {
        const start = opts.from ?? a.boundary(bRef);
        const end = opts.to ?? b.boundary(aRef);
        w = path(start).to(end);
      } else {
        // 45° staircase: the bend points sit on the y-midline at the
        // x where each diagonal leg covers exactly |dy|/2 horizontally.
        const m = aRef.midpoint(bRef);
        const dirX = bRefV.x > aRefV.x ? 1 : -1;
        const halfDy = computed(() => Math.abs(m.y.value - aRef.y.value));
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

    /** Constant spatial speed (px/sec) for token dots. Long wires
     *  take proportionally longer; short wires zip across — natural
     *  motion regardless of routing length. */
    const SPEED = 240;

    /** Send one pulse along `w`. The wire's opacity flashes in lockstep
     *  — visible "this wire is carrying an event right now." */
    const pulse = (w: Path, onArrive?: () => void) => {
      const total = w.length.value;
      const sec = total / SPEED;
      const dist = signal(0);
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

    /** Fire `ev` at random intervals — drives the demo. */
    const ticker = (ev: string, minGap: number, maxGap: number) =>
      anim.run(function* () {
        yield R.float(0.3, minGap);
        while (true) {
          bus.emit(ev);
          yield R.float(minGap, maxGap);
        }
      });

    /** When `from` fires, send a pulse along `w`; on arrival fire `to`. */
    const relay = (from: string, w: Path, to: string) =>
      bus.on(from, () => pulse(w, () => bus.emit(to)));

    /** AND-sync: tokens accumulate from `evA` and `evB`; whenever each
     *  has ≥1, fire `out` and consume one of each. Pending counts live
     *  in a `store`; the slot-dot visuals derive from those counts —
     *  no manual mirroring. */
    const andSync = (evA: string, evB: string, out: string, gate: AnyShape) => {
      const sync = store({ a: 0, b: 0 });
      gate.add(
        lit(gate.bounds.center.offset(-14, 14), () => sync.a > 0),
        lit(gate.bounds.center.offset(+14, 14), () => sync.b > 0),
      );

      const settle = () => {
        const n = Math.min(sync.a, sync.b);
        sync.a -= n;
        sync.b -= n;
        for (let i = 0; i < n; i++) bus.emit(out);
      };
      bus.on(evA, () => {
        sync.a++;
        settle();
      });
      bus.on(evB, () => {
        sync.b++;
        settle();
      });
    };

    /** Hold an arriving event for a randomized interval, then relay. */
    const hold = (
      from: string,
      holdRange: [number, number],
      w: Path,
      out: string,
      gate: AnyShape,
    ) => {
      const holding = signal(false);
      gate.add(lit(gate.bounds.center.down(6), holding));
      anim.loop(function* () {
        yield* bus.until(from);
        holding.value = true;
        yield R.float(holdRange[0], holdRange[1]);
        holding.value = false;
        pulse(w, () => bus.emit(out));
      });
    };

    /** SPLIT — fan one input into N parallel pulses. */
    const split = (from: string, branches: [Path, string][]) =>
      bus.on(from, () => {
        for (const [w, out] of branches) pulse(w, () => bus.emit(out));
      });

    /** CHOICE — fan one input into ONE randomly-picked branch. */
    const choose = (from: string, branches: [Path, string][]) =>
      bus.on(from, () => {
        const [w, out] = R.pick(branches);
        pulse(w, () => bus.emit(out));
      });

    // ── Nodes ───────────────────────────────────────────────────────
    // Top track: A ⋀ B → AND → DELAY → SPLIT → {X, Y}
    const A = source(50, 70, "A", "fire:A");
    const B = source(50, 170, "B", "fire:B");
    const AND = box(200, 120, 60, 48, "AND");
    const DELAY = box(310, 120, 50, 36, "DELAY", -6);
    const SPLIT = node(410, 120);
    s(label(SPLIT.center.up(24), "split", { size: 9, opacity: 0.6 }));
    const X = sink(560, 70, "X", "arrived:X");
    const Y = sink(560, 170, "Y", "arrived:Y");

    // Bottom track: C → CHOICE → {Z | W}
    const C = source(50, 290, "C", "fire:C");
    const CHOICE = box(270, 290, 60, 40, "CHOICE");
    const Z = sink(560, 250, "Z", "arrived:Z");
    const W_ = sink(560, 330, "W", "arrived:W");

    // ── Wires ───────────────────────────────────────────────────────
    // Both AND inputs converge at AND.left; both CHOICE outputs leave
    // from CHOICE.right. The 45° geometry is computed against those
    // anchors, so the staircase lands cleanly on the shared edge.
    const wA = wire(A, AND, { to: AND.bounds.left });
    const wB = wire(B, AND, { to: AND.bounds.left });
    const wAD = wire(AND, DELAY);
    const wDS = wire(DELAY, SPLIT);
    const wSX = wire(SPLIT, X);
    const wSY = wire(SPLIT, Y);
    const wCC = wire(C, CHOICE);
    const wCZ = wire(CHOICE, Z, { from: CHOICE.bounds.right });
    const wCW = wire(CHOICE, W_, { from: CHOICE.bounds.right });

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
