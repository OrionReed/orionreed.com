// Kitchen sink for the v2 animation system. Each strip exercises a
// different yield pattern. Useful as a smoke test and as a reference.

import {
  circle,
  css,
  Diagram,
  easeInOut,
  fadeIn,
  fadeOut,
  label,
  lag,
  Pivot,
  pt,
  Scene,
  sequence,
  signal,
  t,
  tween,
  type Animator,
  type Content,
  type Signal,
} from "../../scene-v2";

// ── Custom generator: spring follow (uses bare `yield;` per frame) ──
function* springTo(
  sig: Signal<number>,
  target: Signal<number>,
  k = 0.1,
  damping = 0.85,
): Animator {
  let v = 0;
  while (true) {
    const dt: number = yield;
    const dx = target.value - sig.value;
    v = (v + dx * k * (dt / 16)) * damping;
    sig.value += v;
  }
}

// ── Custom mini-animator: set text, hold, return ────────────────────
function* setTextFor(
  text: Signal<Content>,
  value: string,
  ms: number,
): Animator {
  text.value = value;
  yield ms;
}

export class MdAnimDemo extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected setup(s: Scene): void {
    s.view(0, 0, 600, 280);

    const sideLabel = (y: number, name: string) =>
      s(label(pt(10, y), t(name).muted(), { size: 11, pivot: Pivot.LEFT }));

    // ── Strip A: tween + easing, looping bounce ────────────────────
    sideLabel(35, "tween");
    const aX = signal(60);
    s(circle(pt(aX, 35), 10, { fill: true }));
    this.anim.loop(function* () {
      yield* tween(aX, 540, 1000, easeInOut);
      yield* tween(aX, 60, 1000, easeInOut);
    });

    // ── Strip B: lag stagger + array sugar (parallel) ──────────────
    sideLabel(105, "lag");
    const bDots = Array.from({ length: 5 }, (_, i) =>
      s(circle(pt(80 + i * 100, 105), 10, { fill: true, opacity: 0 })),
    );
    this.anim.loop(function* () {
      yield* lag(120, ...bDots.map((d) => fadeIn(d, 400)));
      yield 500;
      yield bDots.map((d) => fadeOut(d, 400)); // array = parallel sugar
      yield 300;
    });

    // ── Strip C: spring follow (custom generator + concurrent loops) ─
    sideLabel(175, "spring");
    const cTarget = signal(80);
    const cFollower = signal(80);
    s(circle(pt(cTarget, 175), 6, { fill: true }));
    s(circle(pt(cFollower, 175), 14, { thin: true }));
    // Target oscillates on its own loop.
    this.anim.loop(function* () {
      yield* tween(cTarget, 520, 1500, easeInOut);
      yield* tween(cTarget, 80, 1500, easeInOut);
    });
    // Follower runs forever, never settles (target keeps moving).
    this.anim.loop(() => springTo(cFollower, cTarget));

    // ── Strip D: sequence + reactive label content ─────────────────
    sideLabel(245, "sequence");
    const dText = signal<Content>("ready");
    s(label(pt(300, 245), dText, { size: 14 }));
    this.anim.loop(function* () {
      yield* sequence(
        setTextFor(dText, "one", 700),
        setTextFor(dText, "two", 700),
        setTextFor(dText, "three", 700),
        setTextFor(dText, "...", 500),
      );
    });
  }
}
