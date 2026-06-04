import {
  Anchor,
  type Cell,
  circle,
  Diagram,
  derive,
  label,
  loop,
  type Mount,
  rect,
  stagger,
  Vec,
} from "../../minim";
import { inView, native, scrollProgress, viewProgress } from "../../minim/ext";

const SVG_NS = "http://www.w3.org/2000/svg";

export class MdWaapiDemo extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 310);
    const X = 56;
    const BW = 440;

    const bar = (y: number, name: string, p: Cell<number>): void => {
      s(
        label(
          view
            .at(0, 0)
            .right(20)
            .down(y + 4),
          name,
          { align: Anchor.Left },
        ),
        rect(X, y, BW, 6, { fill: "rgba(127, 127, 127, 0.18)" }),
        rect(
          X,
          y,
          derive(() => BW * p.value),
          6,
          { fill: true },
        ),
        label(
          view
            .at(1, 0)
            .left(20)
            .down(y + 4),
          derive(() => p.value.toFixed(2)),
          { align: Anchor.Right },
        ),
      );
    };

    s(label(view.top.down(20), "waapi — scroll-driven signals"));

    bar(58, "page", scrollProgress());
    const vp = viewProgress(this);
    bar(86, "view", vp);

    const LOOPS = 15;
    const R = 15;
    const tracker = Vec.derive(() => {
      const cx = X + BW * vp.value;
      const a = vp.value * 2 * Math.PI * LOOPS;
      return { x: cx + R * Math.cos(a), y: 150 + R * Math.sin(a) };
    });

    s(
      circle(tracker, 7, { fill: true }),
      label(view.top.down(195), "↑ loops with view progress — scroll the page", { size: 10 }),
      label(
        view.top.down(217),
        derive(() => (inView(this).value ? "in view" : "offscreen")),
      ),
    );

    // Raw SVG nodes (not Shapes) so minim's per-frame effects don't fight WAAPI.
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
      label(view.top.down(248), "native — WAAPI keyframes via `native()`"),
      label(
        view.top.down(295),
        "transform · opacity · filter — compositor-only, ~0 main-thread cost",
        { size: 10 },
      ),
    );

    const kfs: Keyframe[] = [
      {
        transform: "translateY(0px) scale(1)",
        filter: "blur(0px) hue-rotate(0turn)",
        opacity: 0.35,
        offset: 0,
      },
      {
        transform: "translateY(-22px) scale(1.6)",
        filter: "blur(2px) hue-rotate(0.5turn)",
        opacity: 1,
        offset: 0.5,
      },
      {
        transform: "translateY(0px) scale(1)",
        filter: "blur(0px) hue-rotate(1turn)",
        opacity: 0.35,
        offset: 1,
      },
    ];
    this.anim.start(
      loop(function* () {
        yield* stagger(0.05, particles, el =>
          native(el, kfs, { duration: 1400, easing: "ease-in-out" }),
        );
        yield 0.4;
      }),
    );
  }
}
