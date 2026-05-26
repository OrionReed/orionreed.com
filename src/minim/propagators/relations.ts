// relations.ts — propagator combinators (the solver-role layer).
//
// Where lenses define values (`c = a.add(b)` IS the relation), these
// propagators IMPOSE relations between cells that already exist for
// other reasons (handles, animation targets, externally-driven
// signals, etc.). Every combinator returns one or more `Propagator`s
// that go into a `Propagators` instance via `p.add(...)`.
//
// Naming: arithmetic combinators dispatch on the value class's
// `linear` trait, so `add(a, b, c)` works for `Num`, `Vec`, `Box`,
// `Pose`, anything with `Linear<T>`. The `v` prefix is gone.

import type { Num, Signal, Traits, Val, Vec, Writable } from "../signals";
import { isSignal, requireLinear, valFn } from "../signals";
import { type Propagator, propagator } from "./propagator";

type AnyW = Writable<Signal<any>>;
/** Writable carrying T with the `Linear` trait — what arithmetic
 *  combinators (`add`, `sub`, `mid`, `centroid`) require. */
type LinearW<T> = Writable<Signal<T>> & Traits<T, "linear">;

// ─── Arithmetic (Num + Vec + anything Linear) ──────────────────────

/** `a + b = c`. Three propagators (any two derive the third).
 *  Trait-dispatched on the value class's `linear` trait, so works
 *  for `Num`, `Vec`, and any Linear value type. */
export function add<T>(a: LinearW<T>, b: LinearW<T>, c: LinearW<T>): Propagator[] {
  const L = requireLinear(a);
  return [
    propagator([a, b], [c], () => {
      c.value = L.add(a.value, b.value);
    }),
    propagator([a, c], [b], () => {
      b.value = L.sub(c.value, a.value);
    }),
    propagator([b, c], [a], () => {
      a.value = L.sub(c.value, b.value);
    }),
  ];
}

/** `a - b = c`. b-deriving propagator listed before a-deriving so
 *  drag-on-c updates b first (matches "c changed because b changed"). */
export function sub<T>(a: LinearW<T>, b: LinearW<T>, c: LinearW<T>): Propagator[] {
  const L = requireLinear(a);
  return [
    propagator([a, b], [c], () => {
      c.value = L.sub(a.value, b.value);
    }),
    propagator([a, c], [b], () => {
      b.value = L.sub(a.value, c.value);
    }),
    propagator([b, c], [a], () => {
      a.value = L.add(b.value, c.value);
    }),
  ];
}

/** `(a + b) / 2 = m` (midpoint). Drag m → both a and b translate
 *  by the delta; drag a or b → m re-derives. */
export function mid<T>(a: LinearW<T>, b: LinearW<T>, m: LinearW<T>): Propagator[] {
  const L = requireLinear(a);
  return [
    propagator([a, b], [m], () => {
      m.value = L.scale(L.add(a.value, b.value), 0.5);
    }),
    propagator([m], [a, b], () => {
      const cur = L.scale(L.add(a.value, b.value), 0.5);
      const delta = L.sub(m.value, cur);
      a.value = L.add(a.value, delta);
      b.value = L.add(b.value, delta);
    }),
  ];
}

/** Centroid of N values: `c = mean(...vs)`. Drag any vertex →
 *  centroid follows; drag centroid → all vertices translate by the
 *  delta (rigid translation of the cluster). */
export function centroid<T>(c: LinearW<T>, ...vs: LinearW<T>[]): Propagator[] {
  if (vs.length === 0) return [];
  const L = requireLinear(c);
  const inv = 1 / vs.length;
  const computeMean = (): T => {
    let acc = vs[0]!.value;
    for (let i = 1; i < vs.length; i++) acc = L.add(acc, vs[i]!.value);
    return L.scale(acc, inv);
  };
  return [
    propagator(vs, [c], () => {
      c.value = computeMean();
    }),
    propagator([c], vs, () => {
      const cur = computeMean();
      const delta = L.sub(c.value, cur);
      for (const v of vs) v.value = L.add(v.value, delta);
    }),
  ];
}

// ─── Scalar-only ────────────────────────────────────────────────────

/** `a * b = c` (scalar). Three propagators; division-by-zero skips
 *  the inverse direction. */
export function mul(a: Writable<Num>, b: Writable<Num>, c: Writable<Num>): Propagator[] {
  return [
    propagator([a, b], [c], () => {
      c.value = a.value * b.value;
    }),
    propagator([a, c], [b], () => {
      const av = a.value;
      if (av !== 0) b.value = c.value / av;
    }),
    propagator([b, c], [a], () => {
      const bv = b.value;
      if (bv !== 0) a.value = c.value / bv;
    }),
  ];
}

/** `a / b = k` constant aspect ratio (scalar). */
export function aspectRatio(a: Writable<Num>, b: Writable<Num>, k: number): Propagator[] {
  return [
    propagator([a], [b], () => {
      b.value = a.value / k;
    }),
    propagator([b], [a], () => {
      a.value = b.value * k;
    }),
  ];
}

/** `a₁ + a₂ + … + aₙ = total` (scalar). N+1 propagators: parts → total,
 *  and total + (n-1 parts) → missing part for each i. */
export function sum(parts: readonly Writable<Num>[], total: Writable<Num>): Propagator[] {
  if (parts.length === 0) return [];
  if (parts.length === 1) return eq(parts[0]!, total);
  const props: Propagator[] = [];
  props.push(
    propagator(parts, [total], () => {
      let s = 0;
      for (const p of parts) s += p.value;
      total.value = s;
    }),
  );
  for (let i = 0; i < parts.length; i++) {
    const missing = parts[i]!;
    const others = parts.filter((_, j) => j !== i);
    props.push(
      propagator([total, ...others], [missing], () => {
        let s = 0;
        for (const o of others) s += o.value;
        missing.value = total.value - s;
      }),
    );
  }
  return props;
}

// ─── Universal ──────────────────────────────────────────────────────

/** `a = b`. Bidirectional. Works for any value type. */
export function eq<T>(a: Writable<Signal<T>>, b: Writable<Signal<T>>): Propagator[] {
  return [
    propagator([a], [b], () => {
      b.value = a.value;
    }),
    propagator([b], [a], () => {
      a.value = b.value;
    }),
  ];
}

/** Pin a signal to a fixed value. Subscribes to its own target so
 *  external writes that diverge from the constant get restored. */
export function constant<T>(s: Writable<Signal<T>>, v: T): Propagator {
  return propagator([s], [s], () => {
    s.value = v;
  });
}

/** Variadic mutual equality: all cells share the same value. Drag
 *  any one → others follow. N(N-1) propagators. */
export function align<T>(...cells: Writable<Signal<T>>[]): Propagator[] {
  const props: Propagator[] = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = 0; j < cells.length; j++) {
      if (i === j) continue;
      const src = cells[i]!;
      const dst = cells[j]!;
      props.push(
        propagator([src], [dst], () => {
          dst.value = src.value;
        }),
      );
    }
  }
  return props;
}

// ─── Geometric (Vec) ────────────────────────────────────────────────

type WVec = Writable<Vec>;

/** Point at parameter `t ∈ [0,1]` along segment a → b.
 *
 *  Drag p (default): project p onto the segment, update t (clamped).
 *  Drag p with `freeze: 'a'`: a stays, b moves to fit.
 *  Drag p with `freeze: 'b'`: b stays, a moves to fit. */
export function between(
  a: WVec,
  b: WVec,
  t: Writable<Num>,
  p: WVec,
  freeze?: "a" | "b",
): Propagator[] {
  const props: Propagator[] = [];
  // Forward: p = a + t * (b - a).
  props.push(
    propagator([a.x, a.y, b.x, b.y, t], [p.x as AnyW, p.y as AnyW], () => {
      const tv = t.value;
      (p.x as AnyW).value = a.x.value + tv * (b.x.value - a.x.value);
      (p.y as AnyW).value = a.y.value + tv * (b.y.value - a.y.value);
    }),
  );
  if (freeze === "b") {
    props.push(
      propagator([p.x, p.y, t, b.x, b.y], [a.x as AnyW, a.y as AnyW], () => {
        const tv = t.value;
        if (tv === 1) return;
        (a.x as AnyW).value = (p.x.value - tv * b.x.value) / (1 - tv);
        (a.y as AnyW).value = (p.y.value - tv * b.y.value) / (1 - tv);
      }),
    );
  } else if (freeze === "a") {
    props.push(
      propagator([p.x, p.y, t, a.x, a.y], [b.x as AnyW, b.y as AnyW], () => {
        const tv = t.value;
        if (tv === 0) return;
        (b.x as AnyW).value = (p.x.value - (1 - tv) * a.x.value) / tv;
        (b.y as AnyW).value = (p.y.value - (1 - tv) * a.y.value) / tv;
      }),
    );
  } else {
    props.push(
      propagator([p.x, p.y, a.x, a.y, b.x, b.y], [t as AnyW], () => {
        const dx = b.x.value - a.x.value;
        const dy = b.y.value - a.y.value;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-12) return;
        const px = p.x.value - a.x.value;
        const py = p.y.value - a.y.value;
        (t as AnyW).value = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      }),
    );
  }
  return props;
}

/** Keep `|a − b| = d`. Drag a → b moves along (b−a) to maintain
 *  distance; drag b → symmetric. `d` may be a number, a Num signal,
 *  a computed (e.g. `|p − q|` driven by other points), or a closure. */
export function keepDistance(a: WVec, b: WVec, d: Val<number>): Propagator[] {
  const dRead = valFn(d);
  const dDeps = isSignal(d) ? [d] : [];
  return [
    propagator([a.x, a.y, ...dDeps], [b.x as AnyW, b.y as AnyW], () => {
      const dx = b.x.value - a.x.value;
      const dy = b.y.value - a.y.value;
      const cur = Math.hypot(dx, dy);
      if (cur < 1e-12) return;
      const k = dRead() / cur;
      (b.x as AnyW).value = a.x.value + dx * k;
      (b.y as AnyW).value = a.y.value + dy * k;
    }),
    propagator([b.x, b.y, ...dDeps], [a.x as AnyW, a.y as AnyW], () => {
      const dx = a.x.value - b.x.value;
      const dy = a.y.value - b.y.value;
      const cur = Math.hypot(dx, dy);
      if (cur < 1e-12) return;
      const k = dRead() / cur;
      (a.x as AnyW).value = b.x.value + dx * k;
      (a.y as AnyW).value = b.y.value + dy * k;
    }),
  ];
}

/** Project `p` onto the line through `a → b`. p sticks to the line. */
export function onLine(p: WVec, a: WVec, b: WVec): Propagator {
  return propagator([p.x, p.y, a.x, a.y, b.x, b.y], [p.x as AnyW, p.y as AnyW], () => {
    const dx = b.x.value - a.x.value;
    const dy = b.y.value - a.y.value;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return;
    const px = p.x.value - a.x.value;
    const py = p.y.value - a.y.value;
    const t = (px * dx + py * dy) / len2;
    const newX = a.x.value + t * dx;
    const newY = a.y.value + t * dy;
    if (Math.abs(newX - p.x.value) > 1e-9 || Math.abs(newY - p.y.value) > 1e-9) {
      (p.x as AnyW).value = newX;
      (p.y as AnyW).value = newY;
    }
  });
}

/** Keep `p` on a circle of radius `r` around `c`. `r` may be a
 *  number, a Num signal, a computed, or a closure. */
export function onCircle(p: WVec, c: WVec, r: Val<number>): Propagator {
  const rRead = valFn(r);
  const rDeps = isSignal(r) ? [r] : [];
  return propagator([p.x, p.y, c.x, c.y, ...rDeps], [p.x as AnyW, p.y as AnyW], () => {
    const dx = p.x.value - c.x.value;
    const dy = p.y.value - c.y.value;
    const cur = Math.hypot(dx, dy);
    if (cur < 1e-12) return;
    const k = rRead() / cur;
    const newX = c.x.value + dx * k;
    const newY = c.y.value + dy * k;
    if (Math.abs(newX - p.x.value) > 1e-9 || Math.abs(newY - p.y.value) > 1e-9) {
      (p.x as AnyW).value = newX;
      (p.y as AnyW).value = newY;
    }
  });
}

/** Reflect `src` across the line through `a → b` to get `dst`.
 *  Bidirectional. */
export function reflect(src: WVec, a: WVec, b: WVec, dst: WVec): Propagator[] {
  const reflectPt = (
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): [number, number] => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return [px, py];
    const t = ((px - ax) * dx + (py - ay) * dy) / len2;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return [2 * cx - px, 2 * cy - py];
  };
  return [
    propagator([src.x, src.y, a.x, a.y, b.x, b.y], [dst.x as AnyW, dst.y as AnyW], () => {
      const [x, y] = reflectPt(
        src.x.value,
        src.y.value,
        a.x.value,
        a.y.value,
        b.x.value,
        b.y.value,
      );
      (dst.x as AnyW).value = x;
      (dst.y as AnyW).value = y;
    }),
    propagator([dst.x, dst.y, a.x, a.y, b.x, b.y], [src.x as AnyW, src.y as AnyW], () => {
      const [x, y] = reflectPt(
        dst.x.value,
        dst.y.value,
        a.x.value,
        a.y.value,
        b.x.value,
        b.y.value,
      );
      (src.x as AnyW).value = x;
      (src.y as AnyW).value = y;
    }),
  ];
}

// ─── Set narrowing ──────────────────────────────────────────────────

/** A signal whose value is a `Set<T>`. Narrowing propagators
 *  intersect with new evidence. Termination is structural: finite-
 *  height lattice (sets only shrink). */
export type SetCell<T> = Writable<Signal<ReadonlySet<T>>>;

/** "These cells must contain DIFFERENT values." If any cell is a
 *  singleton {v}, eliminate v from the others. */
export function allDifferent<T>(...cells: SetCell<T>[]): Propagator[] {
  const props: Propagator[] = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = 0; j < cells.length; j++) {
      if (i === j) continue;
      const src = cells[i]!;
      const dst = cells[j]!;
      props.push(
        propagator([src], [dst], () => {
          const sv = src.value;
          if (sv.size !== 1) return;
          const [only] = sv;
          const dv = dst.value;
          if (!dv.has(only as T)) return;
          const next = new Set(dv);
          next.delete(only as T);
          if (next.size !== dv.size) dst.value = next;
        }),
      );
    }
  }
  return props;
}
