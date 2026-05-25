// vec-ops.ts — Vec-typed propagator combinators.
//
// Bidirectional vector arithmetic and geometric constraints. Each
// combinator operates on `Writable<Vec>` signals — drag any
// participant and the network solves for the rest. Mostly mirrors
// the scalar combinators in `combinators.ts`, but axis-by-axis.
//
// "Mind-blowing" use case: drag a midpoint, both endpoints move.
// Drag any vertex of a triangle, the centroid follows. Drag the
// centroid, all three vertices translate together.

import type { Num, Writable } from "../signals";
import { type Vec } from "../signals/values/vec";
import { type Propagator, propagator } from "./propagator";

type WVec = Writable<Vec>;
type WNum = Writable<Num>;

const asW = <T>(s: T): Writable<Num> => s as unknown as Writable<Num>;

// ─── Vector arithmetic ──────────────────────────────────────────

/** `a + b = c` over Vecs. Three propagators (any two derive the
 *  third), per-axis. */
export function vAdd(a: WVec, b: WVec, c: WVec): Propagator[] {
  return [
    propagator([a.x, b.x], [asW(c.x)], () => {
      asW(c.x).value = a.x.value + b.x.value;
    }),
    propagator([a.y, b.y], [asW(c.y)], () => {
      asW(c.y).value = a.y.value + b.y.value;
    }),
    propagator([a.x, c.x], [asW(b.x)], () => {
      asW(b.x).value = c.x.value - a.x.value;
    }),
    propagator([a.y, c.y], [asW(b.y)], () => {
      asW(b.y).value = c.y.value - a.y.value;
    }),
    propagator([b.x, c.x], [asW(a.x)], () => {
      asW(a.x).value = c.x.value - b.x.value;
    }),
    propagator([b.y, c.y], [asW(a.y)], () => {
      asW(a.y).value = c.y.value - b.y.value;
    }),
  ];
}

/** `a - b = c` over Vecs. b-deriving propagators are listed first
 *  so a "drag c" event updates b on its first fire (matches the
 *  intuitive "c changed because b changed" reading). */
export function vSub(a: WVec, b: WVec, c: WVec): Propagator[] {
  return [
    propagator([a.x, b.x], [asW(c.x)], () => {
      asW(c.x).value = a.x.value - b.x.value;
    }),
    propagator([a.y, b.y], [asW(c.y)], () => {
      asW(c.y).value = a.y.value - b.y.value;
    }),
    // b derives from a, c — listed before a-deriving so c-drag → b.
    propagator([a.x, c.x], [asW(b.x)], () => {
      asW(b.x).value = a.x.value - c.x.value;
    }),
    propagator([a.y, c.y], [asW(b.y)], () => {
      asW(b.y).value = a.y.value - c.y.value;
    }),
    // a derives from b, c.
    propagator([b.x, c.x], [asW(a.x)], () => {
      asW(a.x).value = b.x.value + c.x.value;
    }),
    propagator([b.y, c.y], [asW(a.y)], () => {
      asW(a.y).value = b.y.value + c.y.value;
    }),
  ];
}

/** `(a + b) / 2 = m` (midpoint). Bidirectional: drag m, both a and
 *  b shift by the delta (translates the segment); drag a or b, m
 *  re-derives. */
export function vMidpoint(a: WVec, b: WVec, m: WVec): Propagator[] {
  return [
    // m derives from a, b.
    propagator([a.x, a.y, b.x, b.y], [asW(m.x), asW(m.y)], () => {
      asW(m.x).value = (a.x.value + b.x.value) / 2;
      asW(m.y).value = (a.y.value + b.y.value) / 2;
    }),
    // m drag → both endpoints translate by delta.
    propagator([m.x, m.y], [asW(a.x), asW(a.y), asW(b.x), asW(b.y)], () => {
      const cx = (a.x.value + b.x.value) / 2;
      const cy = (a.y.value + b.y.value) / 2;
      const dx = m.x.value - cx;
      const dy = m.y.value - cy;
      if (dx === 0 && dy === 0) return;
      asW(a.x).value = a.x.value + dx;
      asW(a.y).value = a.y.value + dy;
      asW(b.x).value = b.x.value + dx;
      asW(b.y).value = b.y.value + dy;
    }),
  ];
}

/** Point at parameter `t ∈ [0,1]` along segment a → b. Drag p:
 *  if `freeze` is "a", b moves to maintain the relation; if "b", a
 *  moves; default keeps both endpoints fixed and updates t. */
export function vBetween(
  a: WVec,
  b: WVec,
  t: WNum,
  p: WVec,
  freeze?: "a" | "b",
): Propagator[] {
  const props: Propagator[] = [];
  // Forward: p = a + t * (b - a).
  props.push(
    propagator([a.x, a.y, b.x, b.y, t], [asW(p.x), asW(p.y)], () => {
      const tv = t.value;
      asW(p.x).value = a.x.value + tv * (b.x.value - a.x.value);
      asW(p.y).value = a.y.value + tv * (b.y.value - a.y.value);
    }),
  );
  // Inverse on p drag: by default, project onto the segment and
  // update t (clamped). If freeze === 'a', recompute b. If 'b',
  // recompute a.
  if (freeze === "b") {
    props.push(
      propagator([p.x, p.y, t, b.x, b.y], [asW(a.x), asW(a.y)], () => {
        const tv = t.value;
        if (tv === 1) return;
        asW(a.x).value = (p.x.value - tv * b.x.value) / (1 - tv);
        asW(a.y).value = (p.y.value - tv * b.y.value) / (1 - tv);
      }),
    );
  } else if (freeze === "a") {
    props.push(
      propagator([p.x, p.y, t, a.x, a.y], [asW(b.x), asW(b.y)], () => {
        const tv = t.value;
        if (tv === 0) return;
        asW(b.x).value = (p.x.value - (1 - tv) * a.x.value) / tv;
        asW(b.y).value = (p.y.value - (1 - tv) * a.y.value) / tv;
      }),
    );
  } else {
    // Default: project p onto line, derive new t, leave a/b alone.
    props.push(
      propagator([p.x, p.y, a.x, a.y, b.x, b.y], [asW(t)], () => {
        const dx = b.x.value - a.x.value;
        const dy = b.y.value - a.y.value;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-12) return;
        const px = p.x.value - a.x.value;
        const py = p.y.value - a.y.value;
        asW(t).value = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      }),
    );
  }
  return props;
}

/** Centroid of N Vecs. Drag any vertex → centroid follows; drag
 *  centroid → all N vertices translate by the delta. */
export function vCentroid(c: WVec, ...vs: WVec[]): Propagator[] {
  if (vs.length === 0) return [];
  const n = vs.length;
  const xs = vs.map(v => v.x);
  const ys = vs.map(v => v.y);
  const xWrites = vs.map(v => asW(v.x));
  const yWrites = vs.map(v => asW(v.y));
  return [
    // Forward: c = mean(vs).
    propagator([...xs, ...ys], [asW(c.x), asW(c.y)], () => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < n; i++) {
        sx += xs[i]!.value;
        sy += ys[i]!.value;
      }
      asW(c.x).value = sx / n;
      asW(c.y).value = sy / n;
    }),
    // Drag c: translate all vertices by delta.
    propagator([c.x, c.y], [...xWrites, ...yWrites], () => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < n; i++) {
        sx += xs[i]!.value;
        sy += ys[i]!.value;
      }
      const cx = sx / n;
      const cy = sy / n;
      const dx = c.x.value - cx;
      const dy = c.y.value - cy;
      if (dx === 0 && dy === 0) return;
      for (let i = 0; i < n; i++) {
        xWrites[i]!.value = xs[i]!.value + dx;
        yWrites[i]!.value = ys[i]!.value + dy;
      }
    }),
  ];
}

// ─── Geometric constraints ──────────────────────────────────────

/** Keep `|a − b|` equal to `d`. When a or b is dragged, the OTHER
 *  is projected to maintain the distance (along the current
 *  direction). Bidirectional rigid bond. */
export function keepDistance(a: WVec, b: WVec, d: number | WNum): Propagator[] {
  const dRead = (): number => (typeof d === "number" ? d : d.value);
  const dDeps: WNum[] = typeof d === "number" ? [] : [d];
  return [
    // a moved → reposition b along (b - a), distance d.
    propagator([a.x, a.y, ...dDeps], [asW(b.x), asW(b.y)], () => {
      const dx = b.x.value - a.x.value;
      const dy = b.y.value - a.y.value;
      const cur = Math.hypot(dx, dy);
      if (cur < 1e-12) return;
      const target = dRead();
      const k = target / cur;
      asW(b.x).value = a.x.value + dx * k;
      asW(b.y).value = a.y.value + dy * k;
    }),
    // b moved → reposition a along (a - b), distance d.
    propagator([b.x, b.y, ...dDeps], [asW(a.x), asW(a.y)], () => {
      const dx = a.x.value - b.x.value;
      const dy = a.y.value - b.y.value;
      const cur = Math.hypot(dx, dy);
      if (cur < 1e-12) return;
      const target = dRead();
      const k = target / cur;
      asW(a.x).value = b.x.value + dx * k;
      asW(a.y).value = b.y.value + dy * k;
    }),
  ];
}

/** Keep `p` collinear with `a → b`: project p onto the line
 *  through a, b. Drag p; it sticks to the line. Drag a or b; p
 *  stays the closest point on the new line. */
export function onLine(p: WVec, a: WVec, b: WVec): Propagator {
  return propagator(
    [p.x, p.y, a.x, a.y, b.x, b.y],
    [asW(p.x), asW(p.y)],
    () => {
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
        asW(p.x).value = newX;
        asW(p.y).value = newY;
      }
    },
  );
}

/** Keep `p` on a circle of radius `r` around `c`. Drag p outside
 *  the circle, it snaps to the nearest point on the circle. Drag
 *  c, p slides with it (radial direction preserved). */
export function vOnCircle(p: WVec, c: WVec, r: number | WNum): Propagator {
  const rRead = (): number => (typeof r === "number" ? r : r.value);
  const rDeps: WNum[] = typeof r === "number" ? [] : [r];
  return propagator(
    [p.x, p.y, c.x, c.y, ...rDeps],
    [asW(p.x), asW(p.y)],
    () => {
      const dx = p.x.value - c.x.value;
      const dy = p.y.value - c.y.value;
      const cur = Math.hypot(dx, dy);
      if (cur < 1e-12) return;
      const target = rRead();
      const k = target / cur;
      const newX = c.x.value + dx * k;
      const newY = c.y.value + dy * k;
      if (Math.abs(newX - p.x.value) > 1e-9 || Math.abs(newY - p.y.value) > 1e-9) {
        asW(p.x).value = newX;
        asW(p.y).value = newY;
      }
    },
  );
}

/** Reflect `src` across the line through `a → b` to get `dst`.
 *  Bidirectional. */
export function vReflect(src: WVec, a: WVec, b: WVec, dst: WVec): Propagator[] {
  const reflect = (px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] => {
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
    propagator(
      [src.x, src.y, a.x, a.y, b.x, b.y],
      [asW(dst.x), asW(dst.y)],
      () => {
        const [x, y] = reflect(
          src.x.value, src.y.value,
          a.x.value, a.y.value, b.x.value, b.y.value,
        );
        asW(dst.x).value = x;
        asW(dst.y).value = y;
      },
    ),
    propagator(
      [dst.x, dst.y, a.x, a.y, b.x, b.y],
      [asW(src.x), asW(src.y)],
      () => {
        const [x, y] = reflect(
          dst.x.value, dst.y.value,
          a.x.value, a.y.value, b.x.value, b.y.value,
        );
        asW(src.x).value = x;
        asW(src.y).value = y;
      },
    ),
  ];
}
