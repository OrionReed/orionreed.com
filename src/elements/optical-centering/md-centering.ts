import {
  Diagram,
  Scene,
  Text,
  align,
  circle,
  css,
  easeInOut,
  easeOut,
  label,
  lag,
  line,
  pt,
  rect,
  signal,
  snapshot,
  t,
  when,
  type Line,
  type LineOpts,
} from "../../minim";

/** Italic letter with optional italic subscript: `math("x", "min")`. */
function math(base: string, sub?: string): Text {
  const b = t(base).italic();
  return sub ? b.sub(t(sub).italic()) : b;
}

/** Perpendicular tick at fraction `t` along `l`, half-length `h`. */
function tick(l: Line, t: number, h: number, opts: LineOpts = {}) {
  const c = l.at(t);
  const off = l.normalAt(t).scale(h);
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

    // ── Phase signals — each is the master clock for one stage of the
    // build-up: 0 = hidden / not-yet-arrived, 1 = fully revealed.
    const lineT = signal(0);
    const morphT = signal(0);
    const xLabelsT = signal(0);
    const yLabelsT = signal(0);
    const boxT = signal(0);
    const centroidT = signal(0);

    // Geometry. Origin near bottom-left; full-extent axes are phantom
    // Lines (never mounted) used as tick references — the visible
    // axes are separate Lines whose tip lerps via the channel signals.
    const O = pt(60, 170);
    const xEnd = pt(570, 170);
    const yEnd = pt(60, 30);
    const F = [0.2, 0.45, 0.7];
    const subs = ["min", "c", "max"];

    const yTip = xEnd.lerp(yEnd, morphT);
    const xAxis = line(O, xEnd); // phantom — full extent
    const yAxis = line(O, yEnd); // phantom — full extent
    const yMorph = line(O, yTip); // phantom — tracks morph (ticks)
    const yShown = when(morphT);

    // Visible axes.
    s(line(O, O.lerp(xEnd, lineT)));
    s(line(O, yTip, { opacity: yShown }));

    // Ticks. Reveal as the line passes them (x); fade in with morph (y).
    F.forEach((f) =>
      s(
        tick(xAxis, f, 7, {
          opacity: lineT.derive((v) => clamp01((v - f) / 0.06)),
        }),
      ),
    );
    F.forEach((f) => s(tick(yMorph, f, 7, { opacity: yShown })));

    // Labels — each group of three labels shares one opacity signal,
    // so a single `.to(1, …)` fades them in together. No SVG group
    // needed; passing the same Signal as the `opacity` opt is enough.
    F.forEach((f, i) =>
      s(
        label(xAxis.at(f).down(24), math("x", subs[i]), {
          size: 16,
          align: align.top,
          opacity: xLabelsT,
        }),
      ),
    );
    F.forEach((f, i) =>
      s(
        label(yAxis.at(f).left(14), math("y", subs[i]), {
          size: 16,
          align: align.right,
          opacity: yLabelsT,
        }),
      ),
    );

    // Box + crosshairs share `boxT`; centroid + its label share
    // `centroidT`. Crosshairs blend a faint baseline (0.6) with the
    // master via `boxT.derive(v => v * 0.6)`.
    const [xMin, xMid, xMax] = F.map((f) => xAxis.at(f));
    const [yMin, yMid, yMax] = F.map((f) => yAxis.at(f));
    const c = pt(xMid.x, yMid.y);

    s(
      rect(pt(xMin.x, yMax.y), pt(xMax.x, yMin.y), {
        thin: true,
        corner: 4,
        opacity: boxT.derive((v) => v * 0.5),
      }),
    );
    s(
      line(xMid, c, {
        thin: true,
        dashed: true,
        opacity: boxT.derive((v) => v * 0.6),
      }),
    );
    s(
      line(yMid, c, {
        thin: true,
        dashed: true,
        opacity: boxT.derive((v) => v * 0.6),
      }),
    );

    s(circle(c, 4, { fill: true, opacity: centroidT }));
    s(
      label(
        c.right(10).up(10),
        t("(", math("x", "c"), ", ", math("y", "c"), ")"),
        { size: 14, align: align.bottomLeft, opacity: centroidT },
      ),
    );

    // Animation script. `snapshot` captures the six phase signals
    // once; `reset()` restores them at the top of each iteration.
    const reset = snapshot(lineT, morphT, xLabelsT, yLabelsT, boxT, centroidT);
    this.anim.loop(function* () {
      reset();
      yield* lineT.to(1, 1.1, easeOut);
      yield 0.24;
      yield* xLabelsT.to(1, 0.45);
      yield 0.72;
      yield* morphT.to(1, 1.2, easeInOut);
      yield 0.24;
      yield* yLabelsT.to(1, 0.45);
      yield 0.24;
      yield* lag(1, boxT.to(1, 0.6), centroidT.to(1, 0.5));
      yield 4.5;
    });
  }
}
