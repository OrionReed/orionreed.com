// vec.ts (spike) — Vec authoring with `field()` and `derived()`
// helpers. Field-lens getters become 1-liners; derived RO views (like
// `magnitude`) are honestly typed (no LiftField type lie).

import { type Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { batch, Signal, type SignalOptions, type Val, valFn, value } from "../signal";
import { type Linear, traits } from "../traits";
import { bind } from "./bind";
import { Num } from "./num";
import { derived, field, type Wr, type Writable } from "./writable";

type V = { x: number; y: number };

export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
export const lerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const metric = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y);
export const equals = (a: V, b: V) => a === b || (a.x === b.x && a.y === b.y);
export const normalize = (v: V): V => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};
export const perp = (v: V): V => ({ x: v.y, y: -v.x });

const linearImpl: Linear<V> = { add, sub, scale };

export class Vec extends Signal<V> {
  static traits = traits<V>()({ linear: linearImpl, lerp, metric, equals });

  declare readonly _writable: Wr<Vec>;

  constructor(v: V = { x: 0, y: 0 }, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  // ── invertibles ─────────────────────────────────────────────────
  add(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(
      v => {
        const o = bf();
        return { x: v.x + o.x, y: v.y + o.y };
      },
      n => {
        const o = bf();
        return { x: n.x - o.x, y: n.y - o.y };
      },
    );
  }
  sub(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(
      v => {
        const o = bf();
        return { x: v.x - o.x, y: v.y - o.y };
      },
      n => {
        const o = bf();
        return { x: n.x + o.x, y: n.y + o.y };
      },
    );
  }
  scale(k: Val<number>): this {
    const kf = valFn(k);
    return this.through(
      v => {
        const k = kf();
        return { x: v.x * k, y: v.y * k };
      },
      n => {
        const k = kf();
        return { x: n.x / k, y: n.y / k };
      },
    );
  }
  offset(dx: Val<number>, dy: Val<number>): this {
    const xf = valFn(dx);
    const yf = valFn(dy);
    return this.through(
      v => ({ x: v.x + xf(), y: v.y + yf() }),
      n => ({ x: n.x - xf(), y: n.y - yf() }),
    );
  }
  up(n: Val<number>): this {
    const f = valFn(n);
    return this.through(
      v => ({ x: v.x, y: v.y - f() }),
      o => ({ x: o.x, y: o.y + f() }),
    );
  }
  down(n: Val<number>): this {
    const f = valFn(n);
    return this.through(
      v => ({ x: v.x, y: v.y + f() }),
      o => ({ x: o.x, y: o.y - f() }),
    );
  }
  left(n: Val<number>): this {
    const f = valFn(n);
    return this.through(
      v => ({ x: v.x - f(), y: v.y }),
      o => ({ x: o.x + f(), y: o.y }),
    );
  }
  right(n: Val<number>): this {
    const f = valFn(n);
    return this.through(
      v => ({ x: v.x + f(), y: v.y }),
      o => ({ x: o.x - f(), y: o.y }),
    );
  }

  // ── non-invertibles ─────────────────────────────────────────────
  normalize(): Vec {
    return Vec.derive(() => normalize(this.value));
  }
  perp(): Vec {
    return Vec.derive(() => perp(this.value));
  }
  lerp(b: Val<V>, t: Val<number>): Vec {
    return Vec.derive(() => lerp(this.value, value(b), value(t)));
  }
  distance(other: Val<V>): Num {
    return this.deriveTo(Num, v => metric(v, value(other)));
  }

  // ── field lenses & derived views — one-line authoring via the
  //    `field` / `derived` helpers. `field()` returns Inherits<this,T>;
  //    `derived()` returns plain T (correct RO semantics). ──
  get x() {
    return field(this, "x", Num);
  }
  get y() {
    return field(this, "y", Num);
  }
  get magnitude() {
    return derived(this, "magnitude", Num, v => Math.hypot(v.x, v.y));
  }

  /** Tween — `this: Writable<Vec>` constrains the receiver to
   *  writable forms; bare RO Vec is rejected at the call site. */
  to(this: Writable<Vec>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}
export interface Vec {
  readonly constructor: typeof Vec;
  get value(): V;
}


export function axes(x: Writable<Num>, y: Writable<Num>): Writable<Vec> {
  // `as unknown as` is a spike-only artefact — the live `Signal.install`
  // returns the OLD `Writable<R>` shape, which doesn't structurally
  // overlap with `Wr<Vec>`. After the live refactor, Signal.install
  // returns the new shape and a single `as Writable<Vec>` suffices.
  return Signal.install(
    Vec,
    () => ({ x: x.value, y: y.value }),
    v => {
      batch(() => {
        x.value = v.x;
        y.value = v.y;
      });
    },
  ) as unknown as Writable<Vec>;
}

export function vec(x: Val<number> = 0, y: Val<number> = 0): Writable<Vec> {
  if (x instanceof Num && y instanceof Num) {
    return axes(x as Writable<Num>, y as Writable<Num>);
  }
  const v = new Vec() as Writable<Vec>;
  bind(v.x, x);
  bind(v.y, y);
  return v;
}
