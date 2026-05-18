// Token-level code morph — four generator-shaped functions, each
// differing from the previous by a small edit. CodeShape.morphTo runs
// a token-level LCS diff, then surgically wraps deletes/inserts in
// inline-block spans that shrink/grow in width. Surrounding text
// reflows naturally as the spans change size; no per-token absolute
// positioning, no WAAPI.

import {Anchor, Diagram, Mount, css, label, loop, signal, vec, type Content} from "../../minim";
import {code, codeStyles} from "../../minim/code";

const STATES = [
  `function* fadeOut(opacity, secs) {
  let t = 0;
  while (t < secs) {
    const dt = yield;
    t += dt;
    opacity.value = 1 - t / secs;
  }
}`,
  `function* fadeIn(opacity, secs) {
  let t = 0;
  while (t < secs) {
    const dt = yield;
    t += dt;
    opacity.value = t / secs;
  }
}`,
  `function* fadeIn(opacity, secs, ease) {
  let t = 0;
  while (t < secs) {
    const dt = yield;
    t += dt;
    opacity.value = ease(t / secs);
  }
}`,
  `function* fadeIn(sig, secs, ease) {
  let t = 0;
  while (t < secs) {
    const dt = yield;
    t += dt;
    sig.value = ease(t / secs);
  }
}`,
];

const LABELS = [
  "fadeOut → fadeIn — flip the lerp direction (small inline edit)",
  "fadeIn → fadeIn(…, ease) — add a parameter, wrap the expression",
  "rename opacity → sig — local rename, trailing tokens slide",
  "back to fadeOut — close the cycle",
];

export class MdCodeDemo extends Diagram {
  static styles = css`
    ${codeStyles}
  `;

  protected scene(s: Mount): void {
    const view = this.view(640, 280);

    const status = signal<Content>(LABELS[0]);

    s(
      label(view.top.down(20), "code — token-level morph between snippets", {
        size: 12,
        opacity: 0.55,
        align: Anchor.Center,
      }),
      label(view.bottom.up(20), status, {
        size: 11,
        opacity: 0.5,
        align: Anchor.Center,
      }),
    );

    const c = s(code(STATES[0], {size: 13}));
    // Anchor the code block at the diagram centre, accounting for its
    // own height: we want the visual rectangle (which grows/shrinks as
    // lines come and go) to stay roughly centred between the labels.
    c.translate.bind(() =>
      vec(
        view.center.x.value - c.width.value / 2,
        view.center.y.value - c.height.value / 2,
      ).value,
    );

    this.anim.start(
      loop(function* () {
        yield 1.4;
        for (let i = 1; i <= STATES.length; i++) {
          status.value = LABELS[(i - 1) % LABELS.length];
          const next = STATES[i % STATES.length];
          yield* c.morphTo(next, 0.7);
          yield 1.4;
        }
      }),
    );
  }
}
