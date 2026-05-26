import {
  Anchor,
  box,
  circle,
  computed,
  Diagram,
  type Easing,
  type Lerp,
  label,
  loop,
  Mount,
  num,
  rect,
  rgb,
  Signal,
  type TraitDict,
  type Tween,
  tween,
  type Val,
  vec,
} from "../../minim";

const W = 640;
const H = 320;
const ROW_H = 50;
const TOP = 50;
const LABEL_X = 24;
const VIS_X = 110;
const VIS_W = 220;
const READ_X = VIS_X + VIS_W + 24;
const DUR = 0.7;
const DWELL = 0.45;

/** Shrink-then-grow string lerp; source switches at the midpoint. */
const stringLerp: Lerp<string> = (a, b, t) => {
  if (t <= 0.5) return a.slice(0, Math.round(a.length * (1 - t * 2)));
  return b.slice(0, Math.round(b.length * (t - 0.5) * 2));
};

/** Reactive string with a `lerp` trait. */
class Text extends Signal<string> {
  static traits: TraitDict<string> & { lerp: Lerp<string> } = { lerp: stringLerp };
  to(target: string, dur: Val<number>, ease?: Easing): Tween<string> {
    return tween(this as never, target, dur, ease);
  }
}
interface Text {
  readonly constructor: typeof Text;
}

const fmtNum = (n: number) => n.toFixed(2);
const fmtVec = (v: { x: number; y: number }) => `(${Math.round(v.x)}, ${Math.round(v.y)})`;
const fmtBox = (b: { w: number; h: number }) => `${Math.round(b.w)}×${Math.round(b.h)}`;
const fmtColor = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b]
    .map(x =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

const rowY = (i: number) => TOP + ROW_H * i;

export class MdLerps extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    s(
      label(view.top.down(22), "one .to(), every value type"),
      label(
        view.bottom.up(20),
        'value classes register `lerp` in their `static traits` dict; `.to(target, dur)` finds it via `Traits<T, "lerp">`. Same call for Num, Vec, Box, Color, Transform, and arbitrary user types.',
        { size: 10 },
      ),
    );

    const baseY = (i: number) => rowY(i) + 9;
    const n = num(0.15);
    const pos = vec(VIS_X + 12, baseY(1));
    const box_ = box(VIS_X + 4, rowY(2) - 6, 30, 20);
    const col = rgb(0.4, 0.6, 0.9);
    const txt = new Text("hello");

    const rowLabel = (i: number, name: string) =>
      label(vec(LABEL_X, baseY(i)), name, { align: Anchor.Left });
    const readout = (i: number, content: Parameters<typeof label>[1]) =>
      label(vec(READ_X, baseY(i)), content, { align: Anchor.Left });
    const track = (x: number, y: number, w: number, h: number, alpha: number) =>
      rect(x, y, w, h, {
        stroke: "transparent",
        fill: `rgba(127,127,127,${alpha})`,
        corner: Math.min(h / 2, 4),
      });

    s(
      rowLabel(0, "number"),
      track(VIS_X, rowY(0) + 4, VIS_W, 10, 0.18),
      rect(
        VIS_X,
        rowY(0) + 4,
        computed(() => n.value * VIS_W),
        10,
        {
          stroke: "transparent",
          fill: true,
        },
      ),
      readout(
        0,
        computed(() => fmtNum(n.value)),
      ),
    );

    s(
      rowLabel(1, "Vec"),
      track(VIS_X, rowY(1) + 5, VIS_W, 8, 0.1),
      circle(pos, 5, { fill: true, stroke: "transparent" }),
      readout(
        1,
        computed(() => fmtVec(pos.value)),
      ),
    );

    s(
      rowLabel(2, "Box"),
      track(VIS_X, rowY(2) - 14, VIS_W, 36, 0.1),
      rect(box_.x, box_.y, box_.w, box_.h, {
        stroke: "transparent",
        fill: true,
        corner: 3,
      }),
      readout(
        2,
        computed(() => fmtBox(box_.value)),
      ),
    );

    s(
      rowLabel(3, "Color"),
      rect(VIS_X, rowY(3) - 6, VIS_W, 22, {
        stroke: "transparent",
        fill: col.css,
        corner: 3,
      }),
      readout(
        3,
        computed(() => fmtColor(col.value)),
      ),
    );

    s(
      rowLabel(4, "string"),
      track(VIS_X, rowY(4) - 6, VIS_W, 22, 0.08),
      label(vec(VIS_X + 10, baseY(4)), txt, { align: Anchor.Left }),
      readout(
        4,
        computed(() => `len=${txt.value.length}`),
      ),
    );

    const FRAMES = [
      {
        n: 0.85,
        v: { x: VIS_X + VIS_W - 12, y: baseY(1) },
        b: { x: VIS_X + VIS_W - 90, y: rowY(2) - 10, w: 80, h: 26 },
        c: { r: 0.95, g: 0.45, b: 0.2, a: 1 },
        t: "morphing",
      },
      {
        n: 0.5,
        v: { x: VIS_X + VIS_W / 2, y: baseY(1) },
        b: { x: VIS_X + VIS_W / 2 - 25, y: rowY(2) - 4, w: 50, h: 16 },
        c: { r: 0.36, g: 0.78, b: 0.45, a: 1 },
        t: "between",
      },
      {
        n: 0.15,
        v: { x: VIS_X + 12, y: baseY(1) },
        b: { x: VIS_X + 4, y: rowY(2) - 6, w: 30, h: 20 },
        c: { r: 0.4, g: 0.6, b: 0.9, a: 1 },
        t: "hello",
      },
    ];

    this.anim.start(
      loop(function* () {
        for (const f of FRAMES) {
          yield [
            n.to(f.n, DUR),
            pos.to(f.v, DUR),
            box_.to(f.b, DUR),
            col.to(f.c, DUR),
            tween(txt as never, f.t, DUR),
          ];
          yield DWELL;
        }
      }),
    );
  }
}
