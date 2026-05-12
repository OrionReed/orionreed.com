// WAAPI bridge demo — four primitives exercising the new
// `minim/waapi.ts` surface:
//
//   scrollProgress() — page-global [0, 1], shown as a fill bar.
//   viewProgress(this) — this element's view-timeline progress;
//     scrubs a tracker dot horizontally as the reader scrolls past.
//   inView(this) — boolean, gates the pulse loop. While the diagram
//     is offscreen the loop sleeps on `untilTrue(visible)`.
//   untilAnimation(a) — the pulse itself is a native WAAPI animation
//     on the inner SVG <circle> (minim manages the wrapping <g>, so
//     there's no signal-vs-compositor conflict). Each loop iteration
//     fires the animation and the generator awaits its 'finish' event.

import {
  Anchor,
  Diagram,
  Scene,
  circle,
  computed,
  css,
  inView,
  label,
  pt,
  rect,
  scrollProgress,
  signal,
  untilTrue,
  viewProgress,
  type Content,
  type ReadonlySignal,
} from "../../minim";

export class MdWaapiDemo extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 580px;
    }
  `;

  protected scene(s: Scene): void {
    const W = 560;
    const H = 290;
    s.view(W, H);

    s(
      label(
        pt(W / 2, 20),
        "waapi — scroll signals + native animation handoff",
        {
          size: 12,
          align: Anchor.Center,
          opacity: 0.6,
        },
      ),
    );

    // ── Two progress bars (scroll & view) ──────────────────────────
    const X = 78;
    const BW = 440;

    const bar = (y: number, name: string, p: ReadonlySignal<number>): void => {
      s(
        label(pt(20, y + 4), name, {
          size: 11,
          align: Anchor.Left,
          opacity: 0.6,
        }),
      );
      s(rect(X, y, BW, 6, { fill: "rgba(127, 127, 127, 0.18)" }));
      s(
        rect(
          X,
          y,
          computed(() => BW * p.value),
          6,
          { fill: true },
        ),
      );
      s(
        label(
          pt(W - 20, y + 4),
          p.derive((v) => v.toFixed(2)),
          {
            size: 11,
            align: Anchor.Right,
            opacity: 0.55,
          },
        ),
      );
    };

    bar(58, "page", scrollProgress());

    // Reuse the same view signal for both the bar and the tracker —
    // each `viewProgress(this)` call would spin up its own
    // scroll-subscription, harmless but wasteful.
    const view = viewProgress(this);
    bar(86, "view", view);

    // ── Tracker dot scrubbing with view progress ───────────────────
    const tx = computed(() => X + BW * view.value);
    s(circle(pt(tx, 145), 8, { fill: true }));
    s(
      label(pt(W / 2, 172), "↑ scrubs with view progress — scroll the page", {
        size: 10,
        align: Anchor.Center,
        opacity: 0.5,
      }),
    );

    const status = signal<Content>("…");
    s(
      label(pt(W / 2, 258), status, {
        size: 10,
        align: Anchor.Center,
        opacity: 0.6,
      }),
    );

    const visible = inView(this);

    this.anim.loop(function* () {
      if (!visible.peek()) {
        status.value = "offscreen — paused on untilTrue(inView(this))";
        yield* untilTrue(visible);
      }
      status.value = "WAAPI pulse on intrinsic — generator awaits 'finish'";
      yield 0.5;
    });
  }
}
