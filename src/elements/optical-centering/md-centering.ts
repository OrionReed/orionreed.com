import {
  circle,
  css,
  Diagram,
  easeInOut,
  easeOut,
  fadeIn,
  group,
  label,
  line,
  lerp,
  pt,
  rect,
  Scene,
  signal,
  Shape,
  t,
  Text,
  tween,
  type Arg,
  type Point,
} from "../../scene-v2";

/** Italic-letter math notation: `math("x", "min")` → italic x with
 *  italic subscript min. Local helper; will lift if other diagrams
 *  end up needing the same shorthand. */
function math(base: string, sub?: string): Text {
  const b = t(base).italic();
  return sub ? b.sub(t(sub).italic()) : b;
}

// ── Local helpers ───────────────────────────────────────────────────
// Lifted to the lib later if/when a third diagram needs them.

/** Perpendicular tick at fraction `f` along the segment from→to. Pure
 *  vector math; tracks reactive endpoints automatically. */
function tick(
  from: Point,
  to: Point,
  f: number,
  half: number,
  opts: { opacity?: Arg<number> } = {},
): Shape {
  const center = lerp(from, to, f);
  const offset = to.sub(from).normalize().perp().scale(half);
  return line(center.sub(offset), center.add(offset), {
    thin: true,
    opacity: opts.opacity,
  });
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── Component ───────────────────────────────────────────────────────

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

    // Geometry. Origin near bottom-left so the duplicate has somewhere
    // to sweep up into. F values are interpolations of the line, not
    // its endpoints — the marked segment lives inside the line.
    const O = pt(60, 170);
    const xEnd = pt(570, 170);
    const yEnd = pt(60, 30);
    const F = [0.2, 0.45, 0.7];
    const subs = ["min", "c", "max"];

    // Axes — visible tip lerps via the channel signal directly.
    s(line(O, lerp(O, xEnd, lineT)));
    const yTip = lerp(xEnd, yEnd, morphT);
    s(line(O, yTip, { opacity: () => (morphT.value > 0 ? 1 : 0) }));

    // Ticks: x at static (O, xEnd) fractions, revealing as line passes;
    // y follows the morphing tip and shows once morph begins.
    s(...F.map((f) =>
      tick(O, xEnd, f, 7, {
        opacity: () => clamp01((lineT.value - f) / 0.06),
      }),
    ));
    s(...F.map((f) =>
      tick(O, yTip, f, 7, { opacity: () => (morphT.value > 0 ? 1 : 0) }),
    ));

    // Label groups — fade together via parent opacity inheritance.
    const xLabels = s(group());
    xLabels.add(...F.map((f, i) =>
      label(lerp(O, xEnd, f).down(24), math("x", subs[i]), {
        size: 16,
        baseline: "top",
      }),
    ));
    xLabels.opacity.value = 0;

    const yLabels = s(group());
    yLabels.add(...F.map((f, i) =>
      label(lerp(O, yEnd, f).left(14), math("y", subs[i]), {
        size: 16,
        anchor: "end",
      }),
    ));
    yLabels.opacity.value = 0;

    // Box, crosshairs (faint baseline opacity, multiplied by group fade).
    const xMin = lerp(O, xEnd, F[0]);
    const xMid = lerp(O, xEnd, F[1]);
    const xMax = lerp(O, xEnd, F[2]);
    const yMin = lerp(O, yEnd, F[0]);
    const yMid = lerp(O, yEnd, F[1]);
    const yMax = lerp(O, yEnd, F[2]);
    const c = pt(xMid.x, yMid.y);

    const boxGroup = s(group());
    boxGroup.add(
      rect(xMin.x(), yMax.y(), xMax.x() - xMin.x(), yMin.y() - yMax.y(),
        { thin: true, corner: 4, opacity: 0.5 }),
      line(xMid, c, { thin: true, dashed: true, opacity: 0.6 }),
      line(yMid, c, { thin: true, dashed: true, opacity: 0.6 }),
    );
    boxGroup.opacity.value = 0;

    const centroidGroup = s(group());
    centroidGroup.add(
      circle(c, 4, { fill: true }),
      label(c.right(10).up(10),
        t("(", math("x", "c"), ", ", math("y", "c"), ")"),
        { size: 14, anchor: "start", baseline: "bottom" }),
    );
    centroidGroup.opacity.value = 0;

    // Animation script — generator runner. `yield* X` delegates to a
    // sub-animation; `yield <ms>` pauses; `yield [a, b]` runs in parallel.
    this.anim.loop(function* () {
      lineT.value = 0;
      morphT.value = 0;
      [xLabels, yLabels, boxGroup, centroidGroup].forEach(
        (g) => (g.opacity.value = 0),
      );

      yield* tween(lineT, 1, 1100, easeOut);
      yield 240;
      yield* fadeIn(xLabels, 450);
      yield 720;
      yield* tween(morphT, 1, 1200, easeInOut);
      yield 240;
      yield* fadeIn(yLabels, 450);
      yield 240;
      yield* fadeIn(boxGroup, 600);
      yield* fadeIn(centroidGroup, 500);
      yield 4500;
    });
  }
}
