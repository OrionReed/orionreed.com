// md-procrustes.ts — drag three handles that exact-preserve each other.
//
// A cluster of shapes (each pointing radially outward from the centroid)
// + `procrustesLens(centers)` → {centroid, rotation, scale}. Three
// handles drive one channel each; cross-channel invariance is exact by
// construction (each bwd is a group action that fixes the other two).
//
// The shapes' orientations are reactively derived from their positions
// relative to the centroid, so rotating the cluster visibly spins every
// shape; scaling pushes them all out (or in) along their current radii.

import {
  Diagram,
  handle,
  label,
  line,
  Mount,
  Num,
  procrustesLens,
  rect,
  vec,
  Vec,
} from "../../minim";

const PT = "#5b8def";
const TR = "#f5a623"; // translate (centroid)
const RT = "#7ed321"; // rotate
const SC = "#e25c5c"; // scale

export class MdProcrustes extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 380);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    // Six points on a rough hexagon; each will get a small rect at it.
    const R = 90;
    const pts = Array.from({ length: 6 }, (_, i) => {
      const θ = (i / 6) * Math.PI * 2;
      return vec(cx + R * Math.cos(θ), cy + R * Math.sin(θ));
    });

    // The three writable aspects.
    const { centroid, rotation, scale } = procrustesLens(pts);

    // Each rect's orientation = angle from centroid to its position. So
    // when the cluster rotates, every rect re-orients reactively.
    for (const p of pts) {
      const orient = Num.derive([p, centroid] as const, ([pv, c]) =>
        Math.atan2(pv.y - c.y, pv.x - c.x),
      );
      s(rect(p, 38, 10, { rotate: orient, fill: PT, opacity: 0.85 }));
    }

    // Rotation handle: at fixed offset along the cluster's rotation axis.
    const rotR = 130;
    const rotHandle = Vec.lens(
      [centroid, rotation] as const,
      ([c, θ]) => ({ x: c.x + rotR * Math.cos(θ), y: c.y + rotR * Math.sin(θ) }),
      (t, [c]) => [undefined, Math.atan2(t.y - c.y, t.x - c.x)] as never,
    );

    // Scale handle: at the cluster's current scale along the rotation axis.
    const scaleHandle = Vec.lens(
      [centroid, rotation, scale] as const,
      ([c, θ, k]) => ({ x: c.x + k * Math.cos(θ), y: c.y + k * Math.sin(θ) }),
      (t, [c, θ]) => {
        const proj = (t.x - c.x) * Math.cos(θ) + (t.y - c.y) * Math.sin(θ);
        return [undefined, undefined, proj] as never;
      },
    );

    s(
      // Faint dashed line from centroid to rotation handle (visual axis).
      line(centroid, rotHandle, { thin: true, opacity: 0.25, dashed: true }),
      // Three aspect handles.
      handle(centroid, { fill: TR, r: 10 }),
      handle(rotHandle, { fill: RT, r: 8 }),
      handle(scaleHandle, { fill: SC, r: 8 }),
      label(
        view.top.down(20),
        "drag orange → translate · green → rotate · red → scale (the other two stay put)",
      ),
      label(
        view.bottom.up(16),
        "procrustesLens(points) → {centroid, rotation, scale} · group actions · exact",
        { size: 10 },
      ),
    );
  }
}
