import {
  Diagram,
  Point,
  Scene,
  Text,
  align,
  circle,
  css,
  easeInOut,
  easeOut,
  label,
  line,
  pt,
  rect,
  snapshot,
  t,
  timeline,
  when,
  type LineOpts,
} from "../../minim";

/** Italic letter with optional italic subscript: `math("x", "min")`. */
function math(base: string, sub?: string): Text {
  const b = t(base).italic();
  return sub ? b.sub(t(sub).italic()) : b;
}

/** Perpendicular tick across segment `a→b` at fraction `f`, half-length
 *  `h`. Segment lives as plain Point math — no phantom Line shape. */
function tick(a: Point, b: Point, f: number, h: number, opts: LineOpts = {}) {
  const c = a.lerp(b, f);
  const off = b.sub(a).normalize().perp().scale(h);
  return line(c.sub(off), c.add(off), { thin: true, ...opts });
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class MdCentering extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected scene(s: Scene): void {
    s.view(-20, -20, 640, 240);

    const tl = timeline({
      intro: { at: 0, dur: 1.1 },
      xLabels: { at: 1.34, dur: 0.45 },
      morph: { at: 2.51, dur: 1.2 },
      yLabels: { at: 3.95, dur: 0.45 },
      box: { at: 4.64, dur: 0.6 },
      centroid: { at: 5.64, dur: 0.5 },
    });
    const lineT = tl.intro.t.derive(easeOut);
    const morphT = tl.morph.t.derive(easeInOut);
    const xLabelsT = tl.xLabels.t;
    const yLabelsT = tl.yLabels.t;
    const boxT = tl.box.t;
    const centroidT = tl.centroid.t;

    const O = pt(60, 170);
    const xEnd = pt(570, 170);
    const yEnd = pt(60, 30);
    const F = [0.2, 0.45, 0.7];
    const subs = ["min", "c", "max"];

    // Morphing y-axis tip — slides along x→y as morph plays.
    const yTip = xEnd.lerp(yEnd, morphT);
    // "y-axis is on stage" — clip.t > 0 ⟺ morph has started; reads as
    // a timeline-native query rather than a derived display flag.
    const yShown = when(tl.morph.t);

    // Visible axes.
    s(line(O, O.lerp(xEnd, lineT)), line(O, yTip, { opacity: yShown }));

    // Labels + ticks. Each group shares one opacity signal so the trio
    // fades in together — no SVG group needed.
    F.forEach((f, i) =>
      s(
        label(O.lerp(xEnd, f).down(24), math("x", subs[i]), {
          size: 16,
          align: align.top,
          opacity: xLabelsT,
        }),
        label(O.lerp(yEnd, f).left(14), math("y", subs[i]), {
          size: 16,
          align: align.right,
          opacity: yLabelsT,
        }),
        tick(O, yTip, f, 7, { opacity: yShown }),
        tick(O, xEnd, f, 7, {
          opacity: lineT.derive((v) => clamp01((v - f) / 0.06)),
        }),
      ),
    );

    // Box + crosshairs share `boxT`; centroid + its label share
    // `centroidT`. Crosshairs blend a faint baseline (0.6) with the
    // master via `boxT.derive(v => v * 0.6)`.
    const [xMin, xMid, xMax] = F.map((f) => O.lerp(xEnd, f));
    const [yMin, yMid, yMax] = F.map((f) => O.lerp(yEnd, f));
    const c = pt(xMid.x, yMid.y);

    s(
      rect(pt(xMin.x, yMax.y), pt(xMax.x, yMin.y), {
        thin: true,
        corner: 4,
        opacity: boxT.derive((v) => v * 0.5),
      }),
      line(xMid, c, {
        thin: true,
        dashed: true,
        opacity: boxT.derive((v) => v * 0.6),
      }),
      line(yMid, c, {
        thin: true,
        dashed: true,
        opacity: boxT.derive((v) => v * 0.6),
      }),
      circle(c, 4, { fill: true, opacity: centroidT }),
      label(
        c.right(10).up(10),
        t("(", math("x", "c"), ", ", math("y", "c"), ")"),
        { size: 14, align: align.bottomLeft, opacity: centroidT },
      ),
    );

    const reset = snapshot(tl.clock);
    this.anim.loop(function* () {
      reset();
      yield* tl;
      yield 4.5;
    });
  }
}
