// Polygon morph — the polygon is a reactive value type whose value
// carries an array of vertices. `Polygon = { vertices: V[] }` is just
// a struct with a custom `lerp` op; `.to(targetPolygon, dur)` falls out.
//
// The demo walks circle → square → triangle → 5-point star →
// hexagon → back-to-circle, all via the same `polygon.to(...)` API
// that Vec / Box / Color use. One reactive value, one tween call,
// any shape with N matching vertices.

import {
  Anchor,
  Diagram,
  Path,
  Vec,
  cell,
  circle,
  label,
  struct,
  type Content,
  type Mount,
  type V,
} from "../../minim";

const W = 640;
const H = 360;

// Vertex count for every keyframe. 24 divides cleanly into 3 / 4 / 6
// / 8 / 12, so each n-gon's corners fall on integer vertex indices.
// Keeping N constant means the lerp can walk vertex-by-vertex.
const N = 24;
const R = 110;

type Polygon = { vertices: V[] };

const Polygon = struct<Polygon>("Polygon", { vertices: [] })
  .equals((a, b) => {
    if (a.vertices.length !== b.vertices.length) return false;
    for (let i = 0; i < a.vertices.length; i++) {
      const va = a.vertices[i];
      const vb = b.vertices[i];
      if (va.x !== vb.x || va.y !== vb.y) return false;
    }
    return true;
  })
  .ops({
    /** Component-wise lerp. Cycles through whichever array is
     *  shorter, so polygons of different lengths still morph cleanly
     *  (in this demo every keyframe has exactly N vertices). */
    lerp: (a, b: Polygon, t: number): Polygon => {
      const n = Math.max(a.vertices.length, b.vertices.length);
      const out: V[] = new Array(n);
      const la = a.vertices.length;
      const lb = b.vertices.length;
      for (let i = 0; i < n; i++) {
        const va = a.vertices[i % la];
        const vb = b.vertices[i % lb];
        out[i] = {
          x: va.x + (vb.x - va.x) * t,
          y: va.y + (vb.y - va.y) * t,
        };
      }
      return { vertices: out };
    },
  })
  .build();

// ── Keyframe builders ──────────────────────────────────────────────
//
// Each emits exactly N vertices. For shapes with fewer than N
// "real" corners, vertices double up at the same position — the
// lerp then SPLITS them apart smoothly when morphing to a finer
// shape. (This is what makes circle→triangle look like the triangle
// "puffs up" into a circle, rather than rotating into place.)

/** Regular n-gon, padded to N vertices by repeating each corner. */
function ngon(corners: number, radius: number): V[] {
  const out: V[] = [];
  for (let i = 0; i < N; i++) {
    const cornerIdx = Math.floor((i * corners) / N);
    const angle = (cornerIdx / corners) * Math.PI * 2 - Math.PI / 2;
    out.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return out;
}

/** Regular m-pointed star with alternating outer/inner radii. */
function star(points: number, outer: number, inner: number): V[] {
  const out: V[] = [];
  const total = points * 2;
  for (let i = 0; i < N; i++) {
    const idx = Math.floor((i * total) / N);
    const radius = idx % 2 === 0 ? outer : inner;
    const angle = (idx / total) * Math.PI * 2 - Math.PI / 2;
    out.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return out;
}

/** Smooth circle (every vertex is "real"). */
function smoothCircle(radius: number): V[] {
  const out: V[] = [];
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    out.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return out;
}

const KEYFRAMES: Array<{ name: string; verts: V[] }> = [
  { name: "circle (24-gon)",        verts: smoothCircle(R) },
  { name: "square (4-gon × 6)",     verts: ngon(4, R) },
  { name: "triangle (3-gon × 8)",   verts: ngon(3, R) },
  { name: "5-point star",           verts: star(5, R, R * 0.4) },
  { name: "hexagon (6-gon × 4)",    verts: ngon(6, R) },
  { name: "8-point star",           verts: star(8, R, R * 0.55) },
];

const DUR = 0.8;
const DWELL = 0.5;

export class MdMorph extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);
    const cx = W / 2;
    const cy = H / 2 + 8;

    s(
      label(view.top.down(22), "Polygon — an array-of-Vec value type", {
        size: 13,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(20),
        "polygon.to(targetShape, dur) — same one-call tween as Vec / Box / Color, on a value type that's an array of points.",
        { size: 10, align: Anchor.Center, opacity: 0.45 },
      ),
    );

    // The polygon is one reactive value carrying N vertices.
    const poly = Polygon.signal({ vertices: KEYFRAMES[0].verts });

    // Derive N reactive Points from the array, centered at (cx, cy).
    // Each `path` vertex tracks one slot of poly.value.vertices.
    const points = Array.from({ length: N }, (_, i) =>
      Vec.derived(() => {
        const v = poly.value.vertices[i] ?? { x: 0, y: 0 };
        return { x: cx + v.x, y: cy + v.y };
      }),
    );

    s(
      new Path(points, {
        closed: true,
        fill: "rgba(127,127,127,0.18)",
        stroke: "currentColor",
        strokeWidth: 2,
      }),
    );

    // Vertex dots — visual evidence that there are N=24 points
    // moving through space, not a single morphing shape primitive.
    // Dots that share a position (e.g. when shape has < N "real"
    // corners) overlap into a brighter point; you can see them
    // separate as the shape morphs to a finer keyframe.
    for (let i = 0; i < N; i++) {
      s(
        circle(points[i], 2.5, {
          fill: "currentColor",
          stroke: "transparent",
          opacity: 0.6,
        }),
      );
    }

    // Status label updates as we cycle through keyframes.
    const status = cell<Content>(KEYFRAMES[0].name);
    s(
      label(view.top.down(46), status, {
        size: 11,
        align: Anchor.Center,
        opacity: 0.55,
      }),
    );

    this.anim.loop(function* () {
      for (let i = 0; i < KEYFRAMES.length; i++) {
        const next = KEYFRAMES[(i + 1) % KEYFRAMES.length];
        status.value = `→ ${next.name}`;
        // The punchline. One method call, animates 24 vertices
        // simultaneously through Polygon.lerp.
        yield* poly.to({ vertices: next.verts }, DUR);
        status.value = next.name;
        yield DWELL;
      }
    });

  }
}
