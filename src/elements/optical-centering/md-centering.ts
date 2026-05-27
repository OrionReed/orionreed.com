import {
  Anchor,
  Box,
  circle,
  Diagram,
  derive,
  easeInOut,
  easeOut,
  type LineOpts,
  label,
  line,
  loop,
  type Mount,
  rect,
  snapshot,
  type Text,
  t,
  timeline,
  Vec,
  vec,
} from "../../minim";

/** Italic letter with optional italic subscript. */
function math(base: string, sub?: string): Text {
  const b = t(base).italic();
  return sub ? b.sub(t(sub).italic()) : b;
}

/** Perpendicular tick across `a→b` at fraction `f`, half-length `h`. */
function tick(a: Vec, b: Vec, f: number, h: number, opts: LineOpts = {}) {
  const c = a.lerp(b, f);
  const off = b.sub(a).normalize().perp().scale(h);
  return line(c.sub(off), c.add(off), { thin: true, ...opts });
}

export class MdCentering extends Diagram {
  protected scene(s: Mount): void {
    this.view(640, 240);

    const tl = timeline({
      intro: { at: 0, dur: 1.1 },
      xLabels: { at: 1.34, dur: 0.45 },
      morph: { at: 2.51, dur: 1.2 },
      yLabels: { at: 3.95, dur: 0.45 },
      box: { at: 4.64, dur: 0.6 },
      centroid: { at: 5.64, dur: 0.5 },
    });
    const lineT = derive(() => easeOut(tl.intro.t.value));
    const morphT = derive(() => easeInOut(tl.morph.t.value));
    const xLabelsT = tl.xLabels.t;
    const yLabelsT = tl.yLabels.t;
    const boxT = tl.box.t;
    const centroidT = tl.centroid.t;

    const O = vec(80, 190);
    const xEnd = vec(590, 190);
    const yEnd = vec(80, 50);
    const F = [0.2, 0.45, 0.7];
    const subs = ["min", "c", "max"];

    const yTip = xEnd.lerp(yEnd, morphT);
    const yShown = derive(() => (tl.morph.t.value ? 1 : 0));

    s(line(O, O.lerp(xEnd, lineT)), line(O, yTip, { opacity: yShown }));

    F.forEach((f, i) =>
      s(
        label(O.lerp(xEnd, f).down(24), math("x", subs[i]), {
          size: 16,
          align: Anchor.Top,
          opacity: xLabelsT,
        }),
        label(O.lerp(yEnd, f).left(14), math("y", subs[i]), {
          size: 16,
          align: Anchor.Right,
          opacity: yLabelsT,
        }),
        tick(O, yTip, f, 7, { opacity: yShown }),
        tick(O, xEnd, f, 7, {
          opacity: derive(() => Math.max(0, Math.min(1, (lineT.value - f) / 0.06))),
        }),
      ),
    );

    const [xMin, xMid, xMax] = F.map(f => O.lerp(xEnd, f));
    const [yMin, yMid, yMax] = F.map(f => O.lerp(yEnd, f));
    const c = Vec.derive(() => ({ x: xMid.x.value, y: yMid.y.value }));

    const rectBox = Box.derive(() => ({
      x: xMin.x.value,
      y: yMin.y.value,
      w: xMax.x.value - xMin.x.value,
      h: yMax.y.value - yMin.y.value,
    }));
    s(
      rect(rectBox, {
        thin: true,
        corner: 4,
        opacity: derive(() => boxT.value * 0.5),
      }),
      line(xMid, c, {
        thin: true,
        dashed: true,
        opacity: derive(() => boxT.value * 0.6),
      }),
      line(yMid, c, {
        thin: true,
        dashed: true,
        opacity: derive(() => boxT.value * 0.6),
      }),
      circle(c, 4, { fill: true, opacity: centroidT }),
      label(c.right(10).up(10), t("(", math("x", "c"), ", ", math("y", "c"), ")"), {
        size: 14,
        align: Anchor.BottomLeft,
        opacity: centroidT,
      }),
    );

    const reset = snapshot(tl.clock);
    this.anim.start(
      loop(function* () {
        reset();
        yield* tl;
        yield 4.5;
      }),
    );
  }
}
