import {
  circle,
  Diagram,
  derive,
  driven,
  easeInOut,
  label,
  loop,
  type Mount,
  num,
  rect,
  tween,
  Vec,
  vec,
} from "../../minim";

/** Two independent animation sequences blended via a weighted-mean
 *  3-input lens.
 *
 *  Sequence A is a continuous orbit (signal-driven). Sequence B is a
 *  discrete pose-pose-pose tween loop visiting four star-points
 *  (generator-driven). Both run forever and write their own `Vec`
 *  cell. The blend's weighted mean is what the black square renders at.
 *  The blend ratio cycles between fully-A and fully-B over ~10s, so
 *  the same scene morphs smoothly from "pure orbit" through "weighted
 *  hybrid" to "pure star-path" and back.
 *
 *  Importantly: the two contributors don't know about each other or
 *  about the blend. They write to ordinary signals; the lens combines
 *  them. Compare to today's "last write wins" — these two could not
 *  share a single signal at all, but the lens lets them share a
 *  *result* without colliding. */
export class MdMix extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 360);
    const cx = view.center.value.x;
    const cy = view.center.value.y - 14;

    // ── Sequence A: continuous orbit ─────────────────────────────
    const t = num(0);
    this.anim.start(driven(t, (dt, _, cur) => cur + dt));
    const seqA = Vec.derive(() => ({
      x: cx + 95 * Math.cos(t.value * 1.4),
      y: cy + 70 * Math.sin(t.value * 1.4),
    }));

    // ── Sequence B: tween-driven star path ───────────────────────
    const STAR_R = 95;
    const star = (i: number) => {
      const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
      return { x: cx + STAR_R * Math.cos(a), y: cy + STAR_R * Math.sin(a) };
    };
    const seqB = vec(star(0).x, star(0).y);
    this.anim.start(
      loop(function* () {
        // Visit alternating vertices so the path traces a 4-pointed
        // star rather than a square — visually distinguishes it from A.
        yield* tween(seqB, star(2), 0.6, easeInOut);
        yield* tween(seqB, star(0), 0.6, easeInOut);
        yield* tween(seqB, star(3), 0.6, easeInOut);
        yield* tween(seqB, star(1), 0.6, easeInOut);
      }),
    );

    // ── Blend weight (auto-cycling) ──────────────────────────────
    const w = num(0);
    this.anim.start(
      loop(function* () {
        yield* tween(w, 1, 4, easeInOut);
        yield 1.0;
        yield* tween(w, 0, 4, easeInOut);
        yield 1.0;
      }),
    );

    // ── The blend ────────────────────────────────────────────────
    // 3-input lens over [seqA, seqB, w]: weighted mean with `w`
    // controlling the per-frame ratio. RO — no canonical inverse for
    // "drag the blended dot toward where?". Either contributor or `w`
    // can be the driver.
    const blend = Vec.derive([seqA, seqB, w] as const, vals => {
      const [a, b, wv] = vals;
      return {
        x: a.x * (1 - wv) + b.x * wv,
        y: a.y * (1 - wv) + b.y * wv,
      };
    });

    // ── Render ───────────────────────────────────────────────────
    // Each contributor's current position, opacity tracking weight.
    s(
      circle(seqA, 5, {
        fill: "#5b8def",
        opacity: derive(() => 0.2 + 0.55 * (1 - w.value)),
      }),
      circle(seqB, 5, {
        fill: "#e25c5c",
        opacity: derive(() => 0.2 + 0.55 * w.value),
      }),
    );

    // The blended position
    s(
      rect(-10, -10, 20, 20, {
        translate: blend,
        fill: "#1a1a1a",
        corner: 4,
      }),
    );

    // ── Weight indicator (passive slider) ────────────────────────
    const SLIDER_W = 240;
    const SLIDER_X0 = cx - SLIDER_W / 2;
    const SLIDER_Y = view.h.value - 38;
    s(
      rect(SLIDER_X0, SLIDER_Y - 1, SLIDER_W, 2, {
        fill: "rgba(127,127,127,0.3)",
        aside: true,
      }),
    );
    s(circle(vec(w.affine(SLIDER_W, SLIDER_X0), SLIDER_Y), 6, { fill: "#1a1a1a" }));

    s(
      label(
        view.top.down(20),
        "two looping sequences (orbit · star-tween) blended via Vec.derive([a, b, w], weightedMean)",
      ),
      label(
        view.bottom.up(64),
        "weight cycles 0 ↔ 1 over ~10s; the blend is the per-frame weighted mean",
        { size: 10 },
      ),
    );
  }
}
