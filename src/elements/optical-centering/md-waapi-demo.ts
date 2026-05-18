// WAAPI / scroll bridge demo. Two halves:
//
//   1. Reactive signals from `minim/ext/waapi.ts`:
//        scrollProgress()   — page-global [0, 1], rendered as a bar.
//        viewProgress(this) — view-timeline progress, rendered as a
//          bar + a tracker tracing a prolate cycloid.
//        inView(this)       — Boolean visibility, live label.
//      These are pure signals — no animator needed; the existing
//      attr/transform effects re-render as the reader scrolls.
//
//   2. `native(el, kf, opts)` — a row of particles each running a
//      compositor-driven WAAPI animation (transform, opacity, filter
//      blur, hue-rotate) choreographed across keyframes and staggered.
//      Driven by a `loop` on the diagram's animator; the `native()`
//      generator yields back when WAAPI's `finish` event fires, so it
//      composes with `stagger`, `all`, `race` like any other animator.
//      Multi-property filter interpolation across N particles is
//      exactly the case where the generator runtime would spend the
//      most main-thread time per frame; here it costs ~nothing.

import {Anchor, Diagram, polar, Mount, circle, computed, label, vec, rect, loop, stagger, type Signal} from "../../minim";
import {inView, native, scrollProgress, viewProgress} from "../../minim/ext";

const SVG_NS = "http://www.w3.org/2000/svg";

export class MdWaapiDemo extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 310);
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

    // ── Native (WAAPI) particle row ─────────────────────────────────
    // A row of bare SVG circles animated by `native()`. The shapes
    // aren't `Shape`s — they're raw DOM nodes appended under the scene
    // root so minim's per-frame transform/opacity effects don't fight
    // the WAAPI animation. Each particle's `transform-origin` is pinned
    // to its centre so `scale()` grows about the dot, not the SVG (0,0).
    const PARTICLES = 18;
    const PY = 270;
    const PR = 5;
    const particles: SVGCircleElement[] = [];
    for (let i = 0; i < PARTICLES; i++) {
      const cx = X + (BW * (i + 0.5)) / PARTICLES;
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", String(cx));
      c.setAttribute("cy", String(PY));
      c.setAttribute("r", String(PR));
      c.setAttribute("fill", "currentColor");
      c.style.transformOrigin = `${cx}px ${PY}px`;
      this.root.el.appendChild(c);
      particles.push(c);
    }

    s(
      label(view.top.down(248), "native — WAAPI keyframes via `native()`", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.6,
      }),
      label(
        view.top.down(295),
        "transform · opacity · filter — compositor-only, ~0 main-thread cost",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );

    // One animation pass: every particle runs the same 3-keyframe
    // routine, staggered by `stride`. `native()` returns an Animator,
    // so `stagger` (a generic shape-agnostic helper) composes over it
    // exactly like over `to()` / `spring()` / etc. `loop` repeats; the
    // beat after each pass keeps things from looking frantic.
    const kfs: Keyframe[] = [
      { transform: "translateY(0px) scale(1)",
        filter: "blur(0px) hue-rotate(0turn)",
        opacity: 0.35, offset: 0 },
      { transform: "translateY(-22px) scale(1.6)",
        filter: "blur(2px) hue-rotate(0.5turn)",
        opacity: 1, offset: 0.5 },
      { transform: "translateY(0px) scale(1)",
        filter: "blur(0px) hue-rotate(1turn)",
        opacity: 0.35, offset: 1 },
    ];
    this.anim.start(
      loop(function* () {
        yield* stagger(0.05, particles, (el) =>
          native(el, kfs, { duration: 1400, easing: "ease-in-out" }),
        );
        yield 0.4;
      }),
    );
  }
}
