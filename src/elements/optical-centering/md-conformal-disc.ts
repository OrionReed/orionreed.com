// md-conformal-disc.ts — hyperbolic triangle in the Poincaré disc.
//
// The Poincaré disc model represents the hyperbolic plane as the open
// unit disc. Geodesics ("straight lines" in the hyperbolic metric)
// are arcs of circles perpendicular to the boundary — diameters are
// the limiting case (circles of infinite radius). Reflections across
// geodesics are circle inversions in those same arcs.
//
// The model is *conformal* — Euclidean angles equal hyperbolic
// angles. So we can read the triangle's interior angles by measuring
// the Euclidean angle between the geodesic-circle tangents at each
// vertex, and Gauss–Bonnet collapses to: area = π − (α + β + γ).
// In the Euclidean plane the same sum is exactly π; here it's strictly
// less. Drag a vertex toward the boundary and watch the angle sum
// shrink toward zero.
//
// Lens story: the three vertices are the only writable inputs.
// Everything else — the curvature of each side, the interior angles,
// the area, and the three reflected sister triangles — is a derived
// signal. Drag any vertex and the entire figure (3 sides + 6 sister
// sides + 3 reflected vertex dots + the live readout) reflows in one
// pass through the dependency graph.

import {
  Anchor,
  type CurveSegment,
  circle,
  computed,
  curve,
  Diagram,
  handle,
  label,
  lens,
  Mount,
  type Of,
  Vec,
  vec,
  type Writable,
} from "../../minim";

type V = Of<Vec>;

interface GeodesicCircle {
  center: V;
  radius: number;
}

/** Circumcircle of three points; null if colinear. */
function circumcircle(A: V, B: V, C: V): GeodesicCircle | null {
  const d = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
  if (Math.abs(d) < 1e-9) return null;
  const aSq = A.x * A.x + A.y * A.y;
  const bSq = B.x * B.x + B.y * B.y;
  const cSq = C.x * C.x + C.y * C.y;
  const ux = (aSq * (B.y - C.y) + bSq * (C.y - A.y) + cSq * (A.y - B.y)) / d;
  const uy = (aSq * (C.x - B.x) + bSq * (A.x - C.x) + cSq * (B.x - A.x)) / d;
  return { center: { x: ux, y: uy }, radius: Math.hypot(A.x - ux, A.y - uy) };
}

/** Inversion of `P` in the unit circle (centred at origin). */
function invertInUnitCircle(P: V): V {
  const m2 = P.x * P.x + P.y * P.y;
  if (m2 === 0) return P;
  return { x: P.x / m2, y: P.y / m2 };
}

/** Inversion of `P` in a circle. */
function invertIn(P: V, c: V, r: number): V {
  const dx = P.x - c.x;
  const dy = P.y - c.y;
  const d2 = dx * dx + dy * dy;
  if (d2 === 0) return P;
  const k = (r * r) / d2;
  return { x: c.x + k * dx, y: c.y + k * dy };
}

/** Geodesic through P and Q in the Poincaré disc. Returns null when
 *  the geodesic is a diameter (P, Q, origin colinear). The geodesic
 *  circle is the unique circle through P, Q, and the inversion of P
 *  in the unit circle — that third point is the property that pins
 *  it perpendicular to the boundary. */
function geodesicCircle(P: V, Q: V): GeodesicCircle | null {
  return circumcircle(P, Q, invertInUnitCircle(P));
}

/** Reflection of `P` across the geodesic through `A` and `B`. In the
 *  Poincaré disc this is inversion in the geodesic circle (or
 *  Euclidean reflection across the diameter, when the geodesic is one). */
function reflectAcrossGeodesic(P: V, A: V, B: V): V {
  const g = geodesicCircle(A, B);
  if (g === null) {
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return P;
    const t = (P.x * dx + P.y * dy) / len2;
    return { x: 2 * t * dx - P.x, y: 2 * t * dy - P.y };
  }
  return invertIn(P, g.center, g.radius);
}

/** Unit tangent at `V_` along the geodesic toward `T`. Used for
 *  measuring hyperbolic angles (which equal Euclidean angles between
 *  the tangents in this conformal model). */
function tangentAt(V_: V, T: V): V {
  const g = geodesicCircle(V_, T);
  if (g === null) {
    const dx = T.x - V_.x;
    const dy = T.y - V_.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }
  // Tangent at a point on a circle is perpendicular to the radius.
  // Of the two perpendicular directions, pick the one pointing toward T.
  const rx = V_.x - g.center.x;
  const ry = V_.y - g.center.y;
  const t1 = { x: -ry, y: rx };
  const va = { x: T.x - V_.x, y: T.y - V_.y };
  const dot = t1.x * va.x + t1.y * va.y;
  const tan = dot >= 0 ? t1 : { x: ry, y: -rx };
  const len = Math.hypot(tan.x, tan.y) || 1;
  return { x: tan.x / len, y: tan.y / len };
}

/** Hyperbolic interior angle at vertex V_ (between sides V_→A and V_→B). */
function angleAt(V_: V, A: V, B: V): number {
  const tA = tangentAt(V_, A);
  const tB = tangentAt(V_, B);
  const dot = tA.x * tB.x + tA.y * tB.y;
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

export class MdConformalDisc extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(440, 440);
    const cx = view.center.value.x;
    const cy = view.center.value.y;
    const R = 180;

    // Disc boundary.
    s(circle(view.center, R, { thin: true, opacity: 0.6 }));

    // Vertices in *world* coords (unit disc centred at origin). We
    // only render in screen coords; the math stays in world coords so
    // the formulas match the textbook Poincaré disc identities.
    const Aw = vec(0.45, -0.3);
    const Bw = vec(-0.4, -0.2);
    const Cw = vec(0.05, 0.55);

    const toScreen = (w: V): V => ({ x: cx + w.x * R, y: cy + w.y * R });
    const fromScreen = (p: V): V => ({ x: (p.x - cx) / R, y: (p.y - cy) / R });

    // Clamp world point to the *open* disc (a hair off the boundary
    // so the geodesic-arc renderer doesn't blow up at radius = 1, where
    // its circle has infinite radius).
    const clampOpen = (w: V): V => {
      const m = Math.hypot(w.x, w.y);
      const max = 0.96;
      if (m <= max) return w;
      return { x: (w.x / m) * max, y: (w.y / m) * max };
    };

    // Screen-space lens onto a world-space vertex. Drag in screen
    // coords; the inverse maps back to world and clamps into the disc.
    const screenLens = (worldVec: Writable<Vec>): Writable<Vec> =>
      lens(
        () => toScreen(worldVec.value),
        target => {
          worldVec.value = clampOpen(fromScreen(target));
        },
        Vec,
      ) as unknown as Writable<Vec>;

    // Curve segment for the geodesic arc from Pw to Qw (world coords),
    // rendered in screen coords. Diameter case falls back to a line.
    const geoArc = (Pw: V, Qw: V): CurveSegment => {
      const g = geodesicCircle(Pw, Qw);
      if (g === null) {
        return { kind: "line", from: toScreen(Pw), to: toScreen(Qw) };
      }
      const cs = toScreen(g.center);
      const rs = g.radius * R;
      const a0 = Math.atan2(Pw.y - g.center.y, Pw.x - g.center.x);
      const a1Raw = Math.atan2(Qw.y - g.center.y, Qw.x - g.center.x);
      let span = a1Raw - a0;
      while (span > Math.PI) span -= 2 * Math.PI;
      while (span < -Math.PI) span += 2 * Math.PI;
      return {
        kind: "ellipseArc",
        center: cs,
        a: rs,
        b: rs,
        rotation: 0,
        a0,
        a1: a0 + span,
      };
    };

    const PRIMARY = "#5b8def";

    s(
      curve(() => [geoArc(Aw.value, Bw.value)], { strokeWidth: 2, stroke: PRIMARY }),
      curve(() => [geoArc(Bw.value, Cw.value)], { strokeWidth: 2, stroke: PRIMARY }),
      curve(() => [geoArc(Cw.value, Aw.value)], { strokeWidth: 2, stroke: PRIMARY }),
    );

    // Three sister triangles. Each is the original reflected across
    // one of its three sides — so each shares one side with the
    // original (already drawn) and contributes two new sides plus one
    // new vertex (the reflection of the opposite vertex). One level
    // of reflection only — the eye reads the partial pattern as
    // hinting at the infinite tessellation.
    const sister = (kept1: () => V, kept2: () => V, opposite: () => V, color: string) => {
      const refl = computed(() => reflectAcrossGeodesic(opposite(), kept1(), kept2()), Vec);
      s(
        curve(() => [geoArc(refl.value, kept1())], {
          strokeWidth: 1.5,
          stroke: color,
          opacity: 0.65,
        }),
        curve(() => [geoArc(refl.value, kept2())], {
          strokeWidth: 1.5,
          stroke: color,
          opacity: 0.65,
        }),
        circle(
          computed(() => toScreen(refl.value), Vec),
          3,
          { fill: color, opacity: 0.75 },
        ),
      );
    };
    sister(
      () => Bw.value,
      () => Cw.value,
      () => Aw.value,
      "#e25c5c",
    );
    sister(
      () => Cw.value,
      () => Aw.value,
      () => Bw.value,
      "#10b981",
    );
    sister(
      () => Aw.value,
      () => Bw.value,
      () => Cw.value,
      "#f5a623",
    );

    // Vertex handles drag in screen space; the screenLens routes the
    // write through clampOpen back into the world-space vertex signal.
    s(handle(screenLens(Aw)));
    s(handle(screenLens(Bw)));
    s(handle(screenLens(Cw)));

    // Live readout. In a Euclidean triangle, α + β + γ = π exactly;
    // here it's strictly less, and the deficit IS the area
    // (Gauss–Bonnet for a triangle on a constant-curvature surface).
    const angleSum = computed(() => {
      const aA = angleAt(Aw.value, Bw.value, Cw.value);
      const aB = angleAt(Bw.value, Cw.value, Aw.value);
      const aC = angleAt(Cw.value, Aw.value, Bw.value);
      return aA + aB + aC;
    });

    s(
      label(view.top.down(20), "drag any vertex — sides curve, sister triangles follow", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.top.down(40),
        () => {
          const sumDeg = ((angleSum.value * 180) / Math.PI).toFixed(1);
          const area = (Math.PI - angleSum.value).toFixed(3);
          return `α + β + γ = ${sumDeg}° (Euclidean: 180°) · area = π − sum = ${area}`;
        },
        { size: 11, align: Anchor.Center, opacity: 0.55 },
      ),
      label(
        view.bottom.up(16),
        "Poincaré disc · geodesics are circles ⊥ boundary · reflections are inversions in those circles",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
