// Box ported to invertible chains. Demonstrates:
//   1. A 4-component value type works cleanly with the same machinery.
//   2. The anchor pattern (`Box.at(u, v)` returning a writable Vec) is
//      a chain step — no bespoke lens construction needed.
//   3. Cross-type chains: Box → Vec via `.at(u, v)`, Vec → Num via `.x`.

import { Signal, value, type Val } from "../signals/signal";
import { LINEAR, LERP, EQUALS, type Linear } from "../signals/traits";
import { Chain, via, type ViaTyped } from "./iso";
import { field } from "./field";
import { Num, NumChain } from "./num";
import { Vec, VecChain, type Value as VecValue } from "./vec";

export interface Value { x: number; y: number; w: number; h: number }

const bAdd = (a: Value, b: Value): Value =>
  ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
const bSub = (a: Value, b: Value): Value =>
  ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
const bScale = (a: Value, k: number): Value =>
  ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
const bLerp = (a: Value, b: Value, t: number): Value => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
});
const bEquals = (a: Value, b: Value) =>
  a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
const bExpand = (b: Value, n: number): Value =>
  ({ x: b.x - n, y: b.y - n, w: b.w + 2 * n, h: b.h + 2 * n });
const bContract = (b: Value, n: number): Value =>
  ({ x: b.x + n, y: b.y + n, w: b.w - 2 * n, h: b.h - 2 * n });

const linearImpl: Linear<Value> = { add: bAdd, sub: bSub, scale: bScale };

/** Chain over `BoxValue`. Same `W`-tracking pattern as `NumChain` /
 *  `VecChain`. Adds:
 *   - cross-type `.at(u, v) → VecChain`: writable iff we know what to
 *     do with the orthogonal axis. We adopt "preserve size, move
 *     position so anchor lands at target" → writable.
 *   - `.field("x"|"y"|"w"|"h") → NumChain`: standard field lens. */
export class BoxChain<W extends boolean> {
  constructor(readonly _chain: Chain<unknown, Value, W>) {}

  static start(): BoxChain<true> {
    return new BoxChain(Chain.of<Value>() as unknown as Chain<unknown, Value, true>);
  }

  // ── Invertible (preserve W) ─────────────────────────────────────
  add(b: Val<Value>): BoxChain<W> {
    return new BoxChain(this._chain.iso({
      fwd: (v) => bAdd(v, value(b)),
      bwd: (v) => bSub(v, value(b)),
    }));
  }
  sub(b: Val<Value>): BoxChain<W> {
    return new BoxChain(this._chain.iso({
      fwd: (v) => bSub(v, value(b)),
      bwd: (v) => bAdd(v, value(b)),
    }));
  }
  scale(k: Val<number>): BoxChain<W> {
    return new BoxChain(this._chain.iso({
      fwd: (v) => bScale(v, value(k)),
      bwd: (v) => bScale(v, 1 / value(k)),
    }));
  }
  /** `expand(n)` and `contract(n)` are inverses. */
  expand(n: Val<number>): BoxChain<W> {
    return new BoxChain(this._chain.iso({
      fwd: (v) => bExpand(v, value(n)),
      bwd: (v) => bContract(v, value(n)),
    }));
  }

  // ── Type-changing to VecChain ───────────────────────────────────
  /** Anchor at `(u, v)` in `[0,1]²`. Writable: setting the anchor
   *  shifts the box's position (size preserved). */
  at(u: number, v: number): VecChain<W> {
    return new VecChain<W>(
      (this._chain as Chain<unknown, Value, W>).iso({
        fwd: (b: Value): VecValue => ({ x: b.x + u * b.w, y: b.y + v * b.h }),
        bwd: (p: VecValue, prev: Value): Value => ({
          x: p.x - u * prev.w,
          y: p.y - v * prev.h,
          w: prev.w,
          h: prev.h,
        }),
        needsPrev: true,
      }) as unknown as Chain<unknown, VecValue, W>,
    );
  }

  // ── Type-changing to NumChain via field ─────────────────────────
  get x(): NumChain<W> {
    return new NumChain<W>(
      (this._chain as Chain<unknown, Value, W>).iso(field<Value, "x">("x")) as unknown as Chain<unknown, number, W>,
    );
  }
  get y(): NumChain<W> {
    return new NumChain<W>(
      (this._chain as Chain<unknown, Value, W>).iso(field<Value, "y">("y")) as unknown as Chain<unknown, number, W>,
    );
  }
  get w(): NumChain<W> {
    return new NumChain<W>(
      (this._chain as Chain<unknown, Value, W>).iso(field<Value, "w">("w")) as unknown as Chain<unknown, number, W>,
    );
  }
  get h(): NumChain<W> {
    return new NumChain<W>(
      (this._chain as Chain<unknown, Value, W>).iso(field<Value, "h">("h")) as unknown as Chain<unknown, number, W>,
    );
  }

  // ── One-way (downgrade to false) ────────────────────────────────
  /** Area — read-only (loses x/y/aspect). */
  get area(): NumChain<false> {
    return new NumChain<false>(
      (this._chain as Chain<unknown, Value, boolean>).ro({
        fwd: (b: Value) => b.w * b.h,
      }) as Chain<unknown, number, false>,
    );
  }
}

export class Box extends Signal<Value> {
  constructor(v: Value = { x: 0, y: 0, w: 0, h: 0 }) { super(v); }

  get [LINEAR](): Linear<Value> { return linearImpl; }
  [LERP](a: Value, b: Value, t: number) { return bLerp(a, b, t); }
  [EQUALS](a: Value, b: Value) { return bEquals(a, b); }

  // Eager methods — one-line forwarders.
  add(b: Val<Value>): Box { return this.derive((c) => c.add(b)); }
  sub(b: Val<Value>): Box { return this.derive((c) => c.sub(b)); }
  scale(k: Val<number>): Box { return this.derive((c) => c.scale(k)); }
  expand(n: Val<number>): Box { return this.derive((c) => c.expand(n)); }

  // Axis lenses (writable; spread-replace through field iso).
  get x(): Num { return this.deriveNum((c) => c.x); }
  get y(): Num { return this.deriveNum((c) => c.y); }
  get w(): Num { return this.deriveNum((c) => c.w); }
  get h(): Num { return this.deriveNum((c) => c.h); }

  // Read-only.
  get area(): ViaTyped<number, false, Num> {
    return this.deriveNum((c) => c.area);
  }

  // Anchor — writable Vec via the .at(u,v) chain step.
  at(u: number, v: number): Vec {
    return this.deriveVec((c) => c.at(u, v));
  }
  get center(): Vec { return this.at(0.5, 0.5); }
  get top(): Vec { return this.at(0.5, 0); }
  get bottom(): Vec { return this.at(0.5, 1); }
  get left(): Vec { return this.at(0, 0.5); }
  get right(): Vec { return this.at(1, 0.5); }

  derive<W extends boolean>(
    fn: (c: BoxChain<true>) => BoxChain<W>,
  ): ViaTyped<Value, W, Box> {
    const chain = fn(BoxChain.start());
    return via(this as Signal<Value>, chain._chain as Chain<Value, Value, W>, Box);
  }
  deriveNum<W extends boolean>(
    fn: (c: BoxChain<true>) => NumChain<W>,
  ): ViaTyped<number, W, Num> {
    const chain = fn(BoxChain.start());
    return via(this as Signal<Value>, chain._chain as Chain<Value, number, W>, Num);
  }
  deriveVec<W extends boolean>(
    fn: (c: BoxChain<true>) => VecChain<W>,
  ): ViaTyped<VecValue, W, Vec> {
    const chain = fn(BoxChain.start());
    return via(this as Signal<Value>, chain._chain as Chain<Value, VecValue, W>, Vec);
  }
}

export const box = (
  x: Val<number> = 0, y: Val<number> = 0,
  w: Val<number> = 0, h: Val<number> = 0,
): Box => {
  const b = new Box();
  b.x.bind(x); b.y.bind(y); b.w.bind(w); b.h.bind(h);
  return b;
};
