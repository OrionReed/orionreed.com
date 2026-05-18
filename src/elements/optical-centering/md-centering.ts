import {Diagram, Mount, Text, Anchor, circle, computed, easeInOut, easeOut, label, line, loop, vec, rect, snapshot, t, timeline, when, type LineOpts, Vec} from "../../minim";

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

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

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
    const lineT = computed(() => (easeOut)(tl.intro.t.value));
    const morphT = computed(() => (easeInOut)(tl.morph.t.value));
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
    const yShown = () => tl.morph.t.value ? 1 : 0;

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
          opacity: computed(() => ((v) => clamp01((v - f) / 0.06))(lineT.value)),
        }),
      ),
    );

    const [xMin, xMid, xMax] = F.map((f) => O.lerp(xEnd, f));
    const [yMin, yMid, yMax] = F.map((f) => O.lerp(yEnd, f));
    const c = vec(xMid.x, yMid.y);

    s(
      rect(vec(xMin.x, yMax.y), vec(xMax.x, yMin.y), {
        thin: true,
        corner: 4,
        opacity: computed(() => ((v) => v * 0.5)(boxT.value)),
      }),
      line(xMid, c, {
        thin: true,
        dashed: true,
        opacity: computed(() => ((v) => v * 0.6)(boxT.value)),
      }),
      line(yMid, c, {
        thin: true,
        dashed: true,
        opacity: computed(() => ((v) => v * 0.6)(boxT.value)),
      }),
      circle(c, 4, { fill: true, opacity: centroidT }),
      label(
        c.right(10).up(10),
        t("(", math("x", "c"), ", ", math("y", "c"), ")"),
        { size: 14, align: Anchor.BottomLeft, opacity: centroidT },
      ),
    );

    const reset = snapshot(tl.clock);
    this.anim.start(loop(function* () {
      reset();
      yield* tl;
      yield 4.5;
    }));
  }
}
