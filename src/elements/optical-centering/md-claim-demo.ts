// Claims demo. A single circle fades in and out, surrounded by three
// claim pips — one per mood (`stays`, `becomes`, `never`). The loop
// alternates a clean fadeIn with a deliberate overshoot; the dots
// flicker as predicates latch and reset per `during` scope. The test
// is the demo is the documentation.

import {
  Anchor,
  Diagram,
  Scene,
  circle,
  claim,
  css,
  during,
  fadeIn,
  fadeOut,
  forEach,
  held,
  label,
  pt,
  verdictDot,
} from "../../minim";

export class MdClaimDemo extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 540px;
    }
  `;

  protected scene(s: Scene): void {
    const W = 520;
    const H = 280;
    s.view(0, 0, W, H);

    // ── The shape under test ─────────────────────────────────────
    const c = s(circle(pt(W / 2, 56), 24, { fill: true, opacity: 0 }));

    // ── Claims: one per mood ─────────────────────────────────────
    const bounded     = claim(c.opacity, "α").stays.in([0, 1]);
    const reachesHalf = claim(c.opacity, "α").becomes.above(0.5);
    const noOvershoot = claim(c.opacity, "α").never.above(1);

    const claims = [bounded, reachesHalf, noOvershoot];
    const allOk = held(...claims);

    // ── Header (aggregate verdict) ───────────────────────────────
    s(label(pt(20, 22), "claims", {
      size: 12, bold: true, align: Anchor.Left,
    }));
    s(label(pt(W - 34, 22), allOk.derive((v) => (v ? "ALL HOLD" : "VIOLATED")), {
      size: 11, align: Anchor.Right, opacity: 0.85,
    }));
    s(verdictDot(allOk, { at: pt(W - 18, 22), r: 6 }));

    // ── Claim rows ───────────────────────────────────────────────
    const ROW_Y = 134;
    const ROW_H = 28;
    forEach(s.root, claims, (cl, i) => {
      const y = ROW_Y + i * ROW_H;
      return [
        verdictDot(cl, { at: pt(28, y), r: 5 }),
        label(pt(44, y), cl.label ?? "?", {
          size: 12, align: Anchor.Left,
        }),
      ];
    });

    // ── Footer ───────────────────────────────────────────────────
    s(label(
      pt(W / 2, H - 16),
      "loops alternate clean fadeIn (all green) with an overshoot run (red latches per scope)",
      { size: 10, align: Anchor.Center, opacity: 0.55 },
    ));

    // ── Loop ─────────────────────────────────────────────────────
    this.anim.loop(function* () {
      // Clean iteration — fadeIn lands at 1, fadeOut returns to 0.
      yield* during(
        (function* () {
          yield* fadeIn(c, 0.5);
          yield 0.6;
          yield* fadeOut(c, 0.4);
        })(),
        ...claims,
      );
      yield 0.8;

      // Overshoot iteration — opacity briefly exceeds 1. `bounded`
      // and `noOvershoot` should latch red and stay red until the
      // next `during` resets them; `reachesHalf` still passes
      // (opacity passes 0.5 on the way up).
      c.opacity.value = 0;
      yield* during(
        (function* () {
          yield* c.opacity.to(0.5, 0.2);
          yield* c.opacity.to(1.3, 0.25);
          yield* c.opacity.to(0.95, 0.2);
          yield 0.3;
          yield* fadeOut(c, 0.35);
        })(),
        ...claims,
      );
      yield 1;
    });
  }
}
