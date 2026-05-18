import {Anchor, Diagram, Mount, circle, computed, fadeIn, fadeOut, forEach, label, loop, vec} from "../../minim";
import {claim, process, verdictDot} from "../../minim/assert";

export class MdClaimDemo extends Diagram {
  protected scene(s: Mount): void {
    const W = 520;
    const view = this.view(W, 330);

    const c = s(circle(view.top.down(56), 24, { fill: true, opacity: 0 }));

    const bounded     = claim(c.opacity, "α").stays.in([0, 1]);
    const reachesHalf = claim(c.opacity, "α").becomes.above(0.5);
    const noOvershoot = claim(c.opacity, "α").never.above(1);

    let iter = 0;
    const intro = process(function* () {
      const variant = iter++ % 3;
      if (variant === 0) {
        yield* fadeIn(c, 0.5);
        yield 0.6;
        yield* fadeOut(c, 0.4);
      } else if (variant === 1) {
        yield* c.opacity.to(0.5, 0.2);
        yield* c.opacity.to(1.3, 0.25);
        yield* c.opacity.to(0.95, 0.2);
        yield 0.3;
        yield* fadeOut(c, 0.35);
      } else {
        yield* fadeIn(c, 0.9);
        yield 1;
        yield* fadeOut(c, 0.6);
      }
    }, bounded, reachesHalf, noOvershoot);

    const fast = claim(intro.duration, "intro").ends.below(1.6);

    const safety   = bounded.and(noOvershoot).labelled("safety");
    const liveness = reachesHalf.and(fast).labelled("liveness");
    const fullSpec = safety.and(liveness).labelled("intro spec");

    s(
      label(vec(20, 22), "claims", {
        size: 12, bold: true, align: Anchor.Left,
      }),
      label(vec(W - 34, 22), computed(() => ((v) => (v ? "ALL HOLD" : "VIOLATED"))(fullSpec.value)), {
        size: 11, align: Anchor.Right, opacity: 0.85,
      }),
      verdictDot(fullSpec, { at: vec(W - 18, 22), r: 6 }),
    );

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

    s(label(
      view.bottom.up(16),
      "atomics latch and reset per intro.run(); composites are pure signal algebra over them",
      { size: 10, align: Anchor.Center, opacity: 0.55 },
    ));

    this.anim.start(loop(function* () {
      yield* intro.run();
      yield 0.8;
    }));
  }
}
