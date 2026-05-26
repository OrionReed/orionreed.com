import {
  Anchor,
  circle,
  computed,
  Diagram,
  handle,
  label,
  line,
  Mount,
  Num,
  num,
  polar,
  range,
  vec,
  type Writable,
} from "../../minim";

const TAU = Math.PI * 2;

// ── Conversions ──────────────────────────────────────────────────
// Standard HSL ↔ RGB. Both in [0,1] for r/g/b/s/l; h in [0, 360).
// Bijection (modulo gray-axis hue ambiguity at s=0).

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r1, g1, b1] =
    hh < 1
      ? [c, x, 0]
      : hh < 2
        ? [x, c, 0]
        : hh < 3
          ? [0, c, x]
          : hh < 4
            ? [0, x, c]
            : hh < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return { r: r1 + m, g: g1 + m, b: b1 + m };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

export class MdColor extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 300);

    // HSL is canonical; three writable nums are the entire state.
    const hue = num(40);
    const sat = num(0.85);
    const lit = num(0.55);

    const cssColor = computed(
      () =>
        `hsl(${hue.value.toFixed(0)}deg, ${(sat.value * 100).toFixed(0)}%, ${(lit.value * 100).toFixed(0)}%)`,
    );

    // R, G, B are 3-input lenses through the bijection. Reading
    // converts HSL → RGB; writing converts the new RGB back and
    // updates all three HSL signals atomically (the engine batches).
    // `vals` arrives pre-peeked; the bwd returns the new (h, s, l)
    // tuple; the engine handles the batched writeback.
    const rgbChannel = (idx: "r" | "g" | "b"): Writable<Num> =>
      Num.lens(
        [hue, sat, lit] as const,
        vals => hslToRgb(vals[0], vals[1], vals[2])[idx],
        (target, vals) => {
          const cur = hslToRgb(vals[0], vals[1], vals[2]);
          const next = { ...cur, [idx]: Math.max(0, Math.min(1, target)) };
          const out = rgbToHsl(next.r, next.g, next.b);
          return [out.h, out.s, out.l];
        },
      );
    const r = rgbChannel("r");
    const g = rgbChannel("g");
    const b = rgbChannel("b");

    // ── Layout grid ────────────────────────────────────────────────
    const WHEEL_CX = 130;
    const WHEEL_CY = 155;
    const WHEEL_R = 80;
    const SLIDER_X0 = 270;
    const SLIDER_X1 = 480;
    const ROW_Y = [90, 125, 160, 220]; // R, G, B, then L (set apart)

    // ── HSL wheel (hue + saturation) ───────────────────────────────
    s(
      circle(vec(WHEEL_CX, WHEEL_CY), WHEEL_R, { thin: true, opacity: 0.4 }),
      circle(vec(WHEEL_CX, WHEEL_CY), 1.5, { fill: true, opacity: 0.3 }),
    );
    // sat (in [0,1]) scaled to pixels, with clamp keeping the picker
    // inside the wheel. hue (degrees) scaled to radians. Both are
    // invertible chains; writes propagate back to sat and hue.
    const satPx = sat.clamp(0, 1).scale(WHEEL_R);
    const hueRad = hue.scale(TAU / 360);
    const picker = polar(vec(WHEEL_CX, WHEEL_CY), satPx, hueRad, "rotate");
    s(handle(picker, { r: 8, fill: () => cssColor.value }));

    // ── Sliders ────────────────────────────────────────────────────
    // Each slider chains a clamp into a bidirectional `range.slider`: writes
    // to the knob's pixel x propagate back through to the source Num.
    const slider = (target: Writable<Num>, y: number, letter: string): void => {
      s(
        line(vec(SLIDER_X0, y), vec(SLIDER_X1, y), { thin: true, opacity: 0.35 }),
        label(vec(SLIDER_X0 - 14, y), letter, { align: Anchor.Right }),
      );
      const knobX = range(SLIDER_X0, SLIDER_X1).slider(target.clamp(0, 1));
      s(handle(vec(knobX, y), { r: 6, fill: () => cssColor.value, cursor: "ew-resize" }));
    };

    slider(r, ROW_Y[0], "R");
    slider(g, ROW_Y[1], "G");
    slider(b, ROW_Y[2], "B");
    slider(lit, ROW_Y[3], "L");

    // ── Caption ────────────────────────────────────────────────────
    s(
      label(view.top.down(20), "five draggable inputs, two coordinate systems, one colour"),
      label(
        view.bottom.up(16),
        "R/G/B = Num.lens([h, s, l], hslToRgb, rgbToHsl) · drag any view; every other view updates through the bijection",
        { size: 10 },
      ),
    );
  }
}
