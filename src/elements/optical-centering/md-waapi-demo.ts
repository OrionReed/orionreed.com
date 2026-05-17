// WAAPI / scroll bridge demo. Exercises the three reactive signals
// from `minim/waapi.ts`:
//
//   scrollProgress() — page-global [0, 1], rendered as a fill bar.
//   viewProgress(this) — this element's view-timeline progress,
//     rendered as a fill bar and as a tracker tracing a prolate
//     cycloid (loops while moving forward).
//   inView(this) — Boolean visibility, rendered as a live label.
//
// All three are pure signals — no `anim.loop` needed; the existing
// attr/transform effects re-render the bars and tracker as the reader
// scrolls. The awaitable surface (`untilAnimation`, `untilInView`,
// `untilOutOfView`) isn't exercised here.

import {Anchor, Diagram, polar, Mount, circle, computed, label, vec, rect, type Signal} from "../../minim";
import {inView, scrollProgress, viewProgress} from "../../minim/ext";

export class MdWaapiDemo extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 230);
    const X = 56;
    const BW = 440;

    const bar = (y: number, name: string, p: Signal<number>): void => {
      s(
        label(view.at(0, 0).right(20).down(y + 4), name, {
          size: 11,
          align: Anchor.Left,
          opacity: 0.6,
        }),
        rect(X, y, BW, 6, { fill: "rgba(127, 127, 127, 0.18)" }),
        rect(X, y, computed(() => ((v) => BW * v)(p.value)), 6, { fill: true }),
        label(
          view.at(1, 0).left(20).down(y + 4),
          computed(() => ((v) => v.toFixed(2))(p.value)),
          {
            size: 11,
            align: Anchor.Right,
            opacity: 0.55,
          },
        ),
      );
    };

    s(
      label(view.top.down(20), "waapi — scroll-driven signals", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.6,
      }),
    );

    bar(58, "page", scrollProgress());
    const vp = viewProgress(this);
    bar(86, "view", vp);

    // Prolate cycloid via `polar(center, radius, angle)`:
    // - `center` advances linearly along the bar with view progress.
    // - `tracker` orbits it at fixed radius; angular speed scales as
    //   `2π · LOOPS` over the [0,1] progress range.
    // The path loops (crosses itself) when `R · 2π · LOOPS > BW` —
    // i.e. the orbit's reverse phase outpaces the center's forward
    // motion. With BW=440, LOOPS=4, R=25 we clear that by ~40%.
    const LOOPS = 15;
    const R = 15;
    const center = vec(computed(() => ((p) => X + BW * p)(vp.value)), 150);
    const tracker = polar(
      center,
      R,
      computed(() => ((p) => p * 2 * Math.PI * LOOPS)(vp.value)),
    );

    s(
      circle(tracker, 7, { fill: true }),
      label(
        view.top.down(195),
        "↑ loops with view progress — scroll the page",
        {
          size: 10,
          align: Anchor.Center,
          opacity: 0.5,
        },
      ),
      label(
        view.top.down(217),
        () => (inView(this).value ? "in view" : "offscreen"),
        { size: 11, align: Anchor.Center, opacity: 0.6 },
      ),
    );
  }
}
