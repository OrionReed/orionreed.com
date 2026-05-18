// Multi-line code morph — three progressively refactored versions of
// the same animation primitive. Each transition involves adding or
// removing whole lines, exercising the morph's vertical-collapse path
// (delete-spans shrink in height as their lines collapse; insert-spans
// grow in height as new lines open up).
//
// The diff also drives token-level horizontal animation within edited
// lines, so a partial-line edit (`1 - t / secs` → `lerp(1, 0, t / secs)`)
// reads as the relevant slot crossfading content while the rest of the
// line shifts to accommodate.

import {Anchor, Diagram, Mount, css, label, loop, signal, vec, type Content} from "../../minim";
import {code, codeStyles} from "../../minim/code";

const STATES = [
  // 1. Inline — direct expression.
  `function* fadeOut(opacity, secs) {
  let t = 0;
  while (t < secs) {
    const dt = yield;
    t += dt;
    opacity.value = 1 - t / secs;
  }
}`,
  // 2. Extract local — pull the progress fraction into a named binding,
  // simplify the expression that uses it.
  `function* fadeOut(opacity, secs) {
  let t = 0;
  while (t < secs) {
    const dt = yield;
    t += dt;
    const u = t / secs;
    opacity.value = 1 - u;
  }
}`,
  // 3. Hoist a helper — add a top-level lerp function above, swap the
  // body's inline math for a call to it.
  `const lerp = (a, b, t) => a + (b - a) * t;

function* fadeOut(opacity, secs) {
  let t = 0;
  while (t < secs) {
    const dt = yield;
    t += dt;
    opacity.value = lerp(1, 0, t / secs);
  }
}`,
];

const LABELS = [
  "1 → 2 — extract a local (one new line in the body)",
  "2 → 3 — hoist a helper (two new lines above; body simplifies)",
  "3 → 1 — collapse back to the original",
];

export class MdCodeRefactor extends Diagram {
  static styles = css`
    ${codeStyles}
  `;

  protected scene(s: Mount): void {
    const view = this.view(640, 340);

    const status = signal<Content>(LABELS[0]);

    s(
      label(view.top.down(20), "code — multi-line refactor morph", {
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
    c.translate.bind(() =>
      vec(
        view.center.x.value - c.width.value / 2,
        view.center.y.value - c.height.value / 2,
      ).value,
    );

    this.anim.start(
      loop(function* () {
        yield 1.6;
        for (let i = 1; i <= STATES.length; i++) {
          status.value = LABELS[(i - 1) % LABELS.length];
          const next = STATES[i % STATES.length];
          yield* c.morphTo(next, 0.9);
          yield 1.6;
        }
      }),
    );
  }
}
