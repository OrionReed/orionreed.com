import {Diagram, EventBus, Mount, type AnyShape, type Val, type Path, signal, circle, computed, label, linear, loop, num, path, play, vec, rect, tokens, value, Vec} from "../../minim";
import * as R from "../rand";

export class MdCircuit extends Diagram {
  protected scene(s: Mount): void {
    this.view(600, 360);
    const anim = this.anim;
    const bus = new EventBus();

    /** Circle + label that scale-pulses on `ev`. */
    const source = (x: number, y: number, lbl: string, ev: string) => {
      const c = circle(vec(x, y), 18);
      s(c, label(c.center, lbl, { size: 13, bold: true }));
      anim.start(loop(function* () {
        yield bus.until(ev);
        yield* c.scale.to({ x: 1.4, y: 1.4 }, 0.08).to({ x: 1, y: 1 }, 0.3);
      }));
      return c;
    };

    /** Counting sink — live count + scale-pulse on each fire. */
    const sink = (x: number, y: number, lbl: string, ev: string) => {
      const c = circle(vec(x, y), 18);
      const tick = signal(0);
      bus.on(ev, () => { tick.value++; });
      s(
        c,
        label(c.center, computed(() => (String)(tick.value)), { size: 13, bold: true }),
        label(c.center.up(30), lbl, { size: 11, opacity: 0.7 }),
      );
      anim.start(loop(function* () {
        yield bus.until(ev);
        yield* c.scale.to({ x: 1.3, y: 1.3 }, 0.06).to({ x: 1, y: 1 }, 0.3);
      }));
      return c;
    };

    /** Boxed gate; `lblY` offsets the title (negative = up). */
    const box = (
      x: number,
      y: number,
      w: number,
      h: number,
      lbl: string,
      lblY = 0,
    ) => {
      const r = rect(vec(x, y), w, h);
      s(
        r,
        label(r.center.offset(0, lblY), lbl, { size: 10, opacity: 0.7 }),
      );
      return r;
    };

    /** Junction circle. */
    const node = (x: number, y: number) => {
      const c = circle(vec(x, y), 9);
      s(c);
      return c;
    };

    /** Indicator dot toggled by a reactive boolean. */
    const lit = (at: Vec, on: Val<boolean>) =>
      circle(at, 4, {
        fill: () => (value(on) ? tokens.stroke : "transparent"),
      });

    /** Reactive auto-route src→tgt with a 45° staircase via the y-midline. */
    const wire = (
      a: AnyShape,
      b: AnyShape,
      opts: { from?: Vec; to?: Vec } = {},
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
        // Bend points on y-midline; each diagonal leg covers |dy|/2 horizontally.
        const m = aRef.lerp(bRef, 0.5);
        const dirX = bRefV.x > aRefV.x ? 1 : -1;
        const halfDy = computed(() => Math.abs(m.y.value - aRef.y.value));
        const pA = vec(() => aRef.x.value + dirX * halfDy.value, m.y);
        const pB = vec(() => bRef.x.value - dirX * halfDy.value, m.y);
        const start = opts.from ?? a.boundary(pA);
        const end = opts.to ?? b.boundary(pB);
        w = path(start).to(pA).to(pB).to(end);
      }
      w.opacity.value = 0.25;
      s(w);
      return w;
    };

    const SPEED = 240;

    /** Send one pulse along `w`; wire opacity flashes in lockstep. */
    const pulse = (w: Path, onArrive?: () => void) => {
      const total = w.length.value;
      const sec = total / SPEED;
      const dist = num(0);
      const dot = circle(w.atDistance(dist), 5, { fill: true });
      s(dot);
      anim.start(
        play([
          dist.to(total, sec, linear),
          w.opacity.to(0.75, sec * 0.3).to(0.25, sec * 0.7),
        ]).then(
          (function* () {
            dot.dispose();
            onArrive?.();
          })(),
        ),
      );
    };

    /** Fire `ev` at random intervals. */
    const ticker = (ev: string, minGap: number, maxGap: number) =>
      anim.start(
        play(R.float(0.3, minGap)).then(
          loop(function* () {
            bus.emit(ev);
            yield R.float(minGap, maxGap);
          }),
        ),
      );

    /** On `from`, send a pulse along `w`; on arrival fire `to`. */
    const relay = (from: string, w: Path, to: string) =>
      bus.on(from, () => pulse(w, () => bus.emit(to)));

    /** AND-sync: when both evA/evB have ≥1 pending, fire `out` and consume one each. */
    const andSync = (evA: string, evB: string, out: string, gate: AnyShape) => {
      const a = signal(0);
      const b = signal(0);
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
      const holding = signal(false);
      gate.add(lit(gate.center.down(6), holding));
      anim.start(loop(function* () {
        yield bus.until(from);
        holding.value = true;
        yield R.float(holdRange[0], holdRange[1]);
        holding.value = false;
        pulse(w, () => bus.emit(out));
      }));
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

    const wA = wire(A, AND, { to: AND.left });
    const wB = wire(B, AND, { to: AND.left });
    const wAD = wire(AND, DELAY);
    const wDS = wire(DELAY, SPLIT);
    const wSX = wire(SPLIT, X);
    const wSY = wire(SPLIT, Y);
    const wCC = wire(C, CHOICE);
    const wCZ = wire(CHOICE, Z, { from: CHOICE.right });
    const wCW = wire(CHOICE, W_, { from: CHOICE.right });

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
