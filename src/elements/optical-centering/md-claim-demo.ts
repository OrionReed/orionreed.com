// Claims demo. A single circle fades in and out; claim pips render
// live verdicts that flicker as predicates latch and reset per
// process run. Showcases all the moving parts:
//
//   - value claims (`.stays`, `.becomes`, `.never`)
//   - a process-duration claim — `claim(intro.duration).ends.below(...)`
//   - layered composition via Claim's chain (`.and().labelled()`)
//   - a persistent process — same `intro` reused across loop
//     iterations, with `intro.duration` re-zeroed each `.run()`
//
// The loop cycles three runs through the same process:
//   - clean fadeIn   → all green
//   - overshoot run  → `bounded` & `noOvershoot` latch red
//   - slow run       → `fast` (duration claim) goes red mid-run
//
// The test is the demo is the documentation.

import {
  Anchor,
  Diagram,
  Mount,
  circle,
  derive,
  fadeIn,
  fadeOut,
  forEach,
  label,
  loop,
  vec,
} from "../../minim";
import { claim, process, verdictDot } from "../../minim/assert";

export class MdClaimDemo extends Diagram {
  protected scene(s: Mount): void {
    const W = 520;
    const view = this.view(W, 330);

    // ── The shape under test ─────────────────────────────────────
    const c = s(circle(view.top.down(56), 24, { fill: true, opacity: 0 }));

    // ── Atomic value claims (one per mood) ───────────────────────
    const bounded     = claim(c.opacity, "α").stays.in([0, 1]);
    const reachesHalf = claim(c.opacity, "α").becomes.above(0.5);
    const noOvershoot = claim(c.opacity, "α").never.above(1);

    // ── A persistent process. The factory branches between three
    //    iteration shapes (clean / overshoot / slow); `intro.duration`
    //    is a signal we can claim against just like any other. ─
    let iter = 0;
    const intro = process(function* () {
      const variant = iter++ % 3;
      if (variant === 0) {
        // Clean — all claims hold.
        yield* fadeIn(c, 0.5);
        yield 0.6;
        yield* fadeOut(c, 0.4);
      } else if (variant === 1) {
        // Overshoot — `bounded` and `noOvershoot` should latch red.
        yield* c.opacity.to(0.5, 0.2);
        yield* c.opacity.to(1.3, 0.25);
        yield* c.opacity.to(0.95, 0.2);
        yield 0.3;
        yield* fadeOut(c, 0.35);
      } else {
        // Slow — same shape as clean, but the longer runtime trips
        // the `fast` duration claim (≥1.6s).
        yield* fadeIn(c, 0.9);
        yield 1;
        yield* fadeOut(c, 0.6);
      }
    }, bounded, reachesHalf, noOvershoot);

    // ── A process-duration claim. Passthrough (`.ends.X`) — reads
    //    live, no latch, so it tracks `intro.duration` continuously
    //    and flips when the run takes too long. ─
    const fast = claim(intro.duration, "intro").ends.below(1.6);

    // ── Layered composition via Claim's chain ───────────────────
    //    Each sub-spec is itself a renderable Claim; the top-level
    //    aggregate is just the AND of two sub-specs.
    const safety   = bounded.and(noOvershoot).labelled("safety");
    const liveness = reachesHalf.and(fast).labelled("liveness");
    const fullSpec = safety.and(liveness).labelled("intro spec");

    // ── Header (aggregate verdict) ───────────────────────────────
    s(
      label(vec(20, 22), "claims", {
        size: 12, bold: true, align: Anchor.Left,
      }),
      label(vec(W - 34, 22), derive(fullSpec, (v) => (v ? "ALL HOLD" : "VIOLATED")), {
        size: 11, align: Anchor.Right, opacity: 0.85,
      }),
      verdictDot(fullSpec, { at: vec(W - 18, 22), r: 6 }),
    );

    // ── Claim rows: atomics on top, composites bold below ────────
    const rows = [
      bounded,
      reachesHalf,
      noOvershoot,
      fast,
      safety,
      liveness,
    ];
    const ROW_Y = 110;
    const ROW_H = 26;
    forEach(s.root, rows, (cl, i) => {
      const y = ROW_Y + i * ROW_H;
      const composite = i >= 4;
      return [
        verdictDot(cl, { at: vec(28, y), r: 5 }),
        label(vec(44, y), cl.label ?? "?", {
          size: 12,
          align: Anchor.Left,
          opacity: composite ? 1 : 0.85,
          bold: composite,
        }),
      ];
    });

    // ── Footer ───────────────────────────────────────────────────
    s(label(
      view.bottom.up(16),
      "atomics latch and reset per intro.run(); composites are pure signal algebra over them",
      { size: 10, align: Anchor.Center, opacity: 0.55 },
    ));

    // ── Loop — just keep running `intro`. Variant cycles inside. ─
    this.anim.run(loop(function* () {
      yield* intro.run();
      yield 0.8;
    }));
  }
}
