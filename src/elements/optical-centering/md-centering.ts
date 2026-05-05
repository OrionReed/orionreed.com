import {
  Diagram,
  Line,
  Pivot,
  Scene,
  Text,
  circle,
  computed,
  css,
  easeInOut,
  easeOut,
  group,
  label,
  line,
  pt,
  rect,
  signal,
  t,
  type LineOpts,
} from "../../minim";

/** Italic letter with optional italic subscript: `math("x", "min")`. */
function math(base: string, sub?: string): Text {
  const b = t(base).italic();
  return sub ? b.sub(t(sub).italic()) : b;
}

/** Perpendicular tick at fraction `t` along `l`, half-length `h`. */
function tick(l: Line, t: number, h: number, opts: LineOpts = {}): Line {
  const c = l.at(t);
  const off = l.normal.scale(h);
  return line(c.sub(off), c.add(off), { thin: true, ...opts });
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class MdCentering extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected setup(s: Scene): void {
    s.view(-20, -20, 640, 240);

    const lineT = signal(0);
    const morphT = signal(0);

    // Geometry. Origin near bottom-left; full-extent axes are phantom
    // Lines (never mounted) used as tick references — the visible
    // axes are separate Lines whose tip lerps via the channel signals.
    const O = pt(60, 170);
    const xEnd = pt(570, 170);
    const yEnd = pt(60, 30);
    const F = [0.2, 0.45, 0.7];
    const subs = ["min", "c", "max"];

    const yTip = xEnd.lerp(yEnd, morphT);
    const xAxis = new Line(O, xEnd); // phantom — full extent
    const yAxis = new Line(O, yEnd); // phantom — full extent (labels, box)
    const yMorph = new Line(O, yTip); // phantom — tracks morph (ticks)
    const yShown = computed(() => (morphT.value > 0 ? 1 : 0));

    // Visible axes — animated.
    s(line(O, O.lerp(xEnd, lineT)));
    s(line(O, yTip, { opacity: yShown }));

    // Ticks. Reveal as the line passes them (x); fade in with morph (y).
    F.forEach((f) =>
      s(
        tick(xAxis, f, 7, {
          opacity: computed(() => clamp01((lineT.value - f) / 0.06)),
        }),
      ),
    );
    F.forEach((f) => s(tick(yMorph, f, 7, { opacity: yShown })));

    // Label groups — fade together via parent opacity inheritance.
    const xLabels = s(group({ opacity: 0 }));
    xLabels.add(
      ...F.map((f, i) =>
        label(xAxis.at(f).down(24), math("x", subs[i]), {
          size: 16,
          anchor: Pivot.TOP,
        }),
      ),
    );

    const yLabels = s(group({ opacity: 0 }));
    yLabels.add(
      ...F.map((f, i) =>
        label(yAxis.at(f).left(14), math("y", subs[i]), {
          size: 16,
          anchor: Pivot.RIGHT,
        }),
      ),
    );

    // Box, crosshairs (faint baseline opacity, multiplied by group fade).
    const [xMin, xMid, xMax] = F.map((f) => xAxis.at(f));
    const [yMin, yMid, yMax] = F.map((f) => yAxis.at(f));
    const c = pt(xMid.x, yMid.y);

    const boxGroup = s(group({ opacity: 0 }));
    boxGroup.add(
      rect(
        xMin.x,
        yMax.y,
        computed(() => xMax.x.value - xMin.x.value),
        computed(() => yMin.y.value - yMax.y.value),
        { thin: true, corner: 4, opacity: 0.5 },
      ),
      line(xMid, c, { thin: true, dashed: true, opacity: 0.6 }),
      line(yMid, c, { thin: true, dashed: true, opacity: 0.6 }),
    );

    const centroidGroup = s(group({ opacity: 0 }));
    centroidGroup.add(
      circle(c, 4, { fill: true }),
      label(
        c.right(10).up(10),
        t("(", math("x", "c"), ", ", math("y", "c"), ")"),
        { size: 14, anchor: Pivot.BL },
      ),
    );

    // Animation script.
    this.anim.loop(function* () {
      lineT.value = 0;
      morphT.value = 0;
      [xLabels, yLabels, boxGroup, centroidGroup].forEach(
        (g) => (g.opacity.value = 0),
      );

      yield* lineT.to(1, 1.1, easeOut);
      yield 0.24;
      yield* xLabels.opacity.to(1, 0.45);
      yield 0.72;
      yield* morphT.to(1, 1.2, easeInOut);
      yield 0.24;
      yield* yLabels.opacity.to(1, 0.45);
      yield 0.24;
      yield* boxGroup.opacity.to(1, 0.6);
      yield* centroidGroup.opacity.to(1, 0.5);
      yield 4.5;
    });
  }
}
