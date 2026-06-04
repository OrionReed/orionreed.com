// md-traits-cross-domain.ts — same `paletteLens(inputs) → {mean, spread}`
// across three different value classes, all wired into a single master.
//
// Each row is one domain:
//   Vecs    — 5 dots; mean is a 2-D canvas drag.
//   Colors  — 5 swatches + a 2-D (r, g) picker that's also the mean swatch.
//   Poses   — 5 oriented arrows; mean drag is over position (theta is averaged).
//
// Per-row sliders drive each spread independently. The MASTER slider
// at the bottom is `meanOf` over the three normalised spreads — drag
// any of the four, the rest follow. One lens primitive, three domains,
// one composition. The trait dispatch (`Linear + Metric`) is what
// lets `paletteLens` work uniformly across them.
//
// `spreadOf` is a symmetric lens: dragging spread to 0 truly collapses
// the cluster to its centroid (no epsilon clamp), but the per-input
// unit directions live in the lens's complement, so any subsequent
// non-zero spread write reinflates the original geometry exactly. The
// "black-hole" trap is structurally absent.

import {
  type Cell,
  type Color,
  Diagram,
  handle,
  label,
  line,
  type Mount,
  meanOf,
  Num,
  paletteLens,
  pose,
  rect,
  rgba,
  Vec,
  vec,
  type Writable,
} from "../../minim";

type PoseV = { x: number; y: number; theta: number };
type ColorV = { r: number; g: number; b: number; a: number };

export class MdTraitsCrossDomain extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(720, 500);

    // ── Domain 1: Vecs. ──────────────────────────────────────────────
    const VX = 110;
    const VSP = 50;
    const vecs = [
      vec(VX, 80),
      vec(VX + VSP, 80),
      vec(VX + 2 * VSP, 98),
      vec(VX + 3 * VSP, 80),
      vec(VX + 4 * VSP, 68),
    ];
    const { mean: vecMean, spread: vecSpread } = paletteLens(vecs as never) as unknown as {
      mean: Writable<Vec>;
      spread: Writable<Num>;
    };

    // ── Domain 2: Colors. ────────────────────────────────────────────
    const colors = [
      rgba(0.9, 0.2, 0.3, 1),
      rgba(0.2, 0.7, 0.4, 1),
      rgba(0.3, 0.4, 0.9, 1),
      rgba(0.9, 0.7, 0.2, 1),
      rgba(0.5, 0.2, 0.8, 1),
    ];
    const { mean: colorMean, spread: colorSpread } = paletteLens(colors as never) as unknown as {
      mean: Writable<Color>;
      spread: Writable<Num>;
    };

    // ── Domain 3: Poses. ─────────────────────────────────────────────
    const PY = 360;
    const poses = [
      pose({ x: VX, y: PY, theta: -0.5 }),
      pose({ x: VX + VSP, y: PY + 10, theta: -0.25 }),
      pose({ x: VX + 2 * VSP, y: PY, theta: 0 }),
      pose({ x: VX + 3 * VSP, y: PY - 10, theta: 0.25 }),
      pose({ x: VX + 4 * VSP, y: PY, theta: 0.5 }),
    ];
    const { mean: poseMean, spread: poseSpread } = paletteLens(poses as never) as unknown as {
      mean: Writable<Cell<PoseV>>;
      spread: Writable<Num>;
    };

    // ── Normalised spreads (so master can be unit-agnostic). ─────────
    const v0 = vecSpread.value;
    const c0 = colorSpread.value;
    const p0 = poseSpread.value;
    const SMAX = 2.0;
    const vecRel = Num.lens(
      [vecSpread] as const,
      ([sv]) => sv / v0,
      t => [t * v0] as never,
    );
    const colorRel = Num.lens(
      [colorSpread] as const,
      ([sv]) => sv / c0,
      t => [t * c0] as never,
    );
    const poseRel = Num.lens(
      [poseSpread] as const,
      ([sv]) => sv / p0,
      t => [t * p0] as never,
    );
    const master = meanOf([vecRel, colorRel, poseRel] as never);

    // ── Slider layout. ───────────────────────────────────────────────
    const SX = 440;
    const SW = 220;
    const sliderHandle = (val: Writable<Num>, y: number) =>
      Vec.lens(
        [val] as const,
        (vals: readonly number[]) => ({ x: SX + (vals[0]! / SMAX) * SW, y }),
        (t: { x: number; y: number }) =>
          [Math.max(0, Math.min(SMAX, ((t.x - SX) / SW) * SMAX))] as never,
      );
    const vecSliderH = sliderHandle(vecRel, 90);
    const colorSliderH = sliderHandle(colorRel, 210);
    const poseSliderH = sliderHandle(poseRel, 360);
    const masterSliderH = sliderHandle(master as never as Writable<Num>, 450);

    // ── Color picker geometry: 50×50 square right of the swatches. ───
    const SW_SIZE = 38;
    const SW_Y = 200;
    const PICK_SIZE = 56;
    const PICK_CX = VX + 5 * VSP + 4;
    const PICK_CY = SW_Y;
    const PICK_R = PICK_SIZE - 16; // dot's draggable range, leaves margin
    const PICK_X0 = PICK_CX - PICK_R / 2;
    const PICK_Y0 = PICK_CY - PICK_R / 2;
    const colorMeanHandle = Vec.lens(
      [colorMean] as const,
      (vals: readonly ColorV[]) => ({
        x: PICK_X0 + vals[0]!.r * PICK_R,
        y: PICK_Y0 + vals[0]!.g * PICK_R,
      }),
      (t: { x: number; y: number }, vals: readonly ColorV[]) =>
        [
          {
            r: Math.max(0, Math.min(1, (t.x - PICK_X0) / PICK_R)),
            g: Math.max(0, Math.min(1, (t.y - PICK_Y0) / PICK_R)),
            b: vals[0]!.b,
            a: vals[0]!.a,
          },
        ] as never,
    );

    s(
      // ── Row 1: Vecs ──
      ...vecs.map(v => handle(v, { fill: "#5b8def", r: 7 })),
      handle(vecMean, { fill: "#f5a623", r: 11 }),

      // ── Row 2: Colors ──
      ...colors.map((c, i) => rect(vec(VX + i * VSP, SW_Y), SW_SIZE, SW_SIZE, { fill: c.css })),
      // The picker IS the mean swatch — filled with the live mean
      // colour. Drag the dot inside to translate the palette in RGB.
      rect(vec(PICK_CX, PICK_CY), PICK_SIZE, PICK_SIZE, { fill: colorMean.css }),
      rect(vec(PICK_CX, PICK_CY), PICK_SIZE, PICK_SIZE, { thin: true, stroke: "#222" }),
      handle(colorMeanHandle, { fill: "#222", r: 5 }),

      // ── Row 3: Poses ──
      ...poses.flatMap(p => {
        const pPos = Vec.lens(
          [p] as const,
          (vals: readonly PoseV[]) => ({ x: vals[0]!.x, y: vals[0]!.y }),
          (t: { x: number; y: number }, vals: readonly PoseV[]) =>
            [{ ...vals[0]!, x: t.x, y: t.y }] as never,
        );
        const pTip = Vec.derive([p] as const, (vals: readonly PoseV[]) => ({
          x: vals[0]!.x + 20 * Math.cos(vals[0]!.theta),
          y: vals[0]!.y + 20 * Math.sin(vals[0]!.theta),
        }));
        return [
          line(pPos, pTip, { stroke: "#7ed321", strokeWidth: 2.5 }),
          handle(pPos, { fill: "#7ed321", r: 5 }),
        ];
      }),
      handle(
        Vec.lens(
          [poseMean] as const,
          (vals: readonly PoseV[]) => ({ x: vals[0]!.x, y: vals[0]!.y }),
          (t: { x: number; y: number }, vals: readonly PoseV[]) =>
            [{ ...vals[0]!, x: t.x, y: t.y }] as never,
        ),
        { fill: "#f5a623", r: 11 },
      ),

      // ── Slider tracks ──
      line(vec(SX, 90), vec(SX + SW, 90), { thin: true, opacity: 0.4 }),
      line(vec(SX, 210), vec(SX + SW, 210), { thin: true, opacity: 0.4 }),
      line(vec(SX, 360), vec(SX + SW, 360), { thin: true, opacity: 0.4 }),
      line(vec(SX, 450), vec(SX + SW, 450), { thin: true, opacity: 0.7 }),

      // ── Slider handles ──
      handle(vecSliderH, { fill: "#222", r: 7 }),
      handle(colorSliderH, { fill: "#222", r: 7 }),
      handle(poseSliderH, { fill: "#222", r: 7 }),
      handle(masterSliderH, { fill: "#e25c5c", r: 11 }),

      // ── Labels ──
      label(vec(SX, 72), "vec spread", { size: 11, opacity: 0.7 }),
      label(vec(SX, 192), "color spread", { size: 11, opacity: 0.7 }),
      label(vec(SX, 342), "pose spread", { size: 11, opacity: 0.7 }),
      label(vec(SX, 432), "MASTER = meanOf(spreads)", { size: 11, opacity: 0.9 }),
      label(
        view.top.down(18),
        "drag any spread slider — the master tracks the mean; drag master, all three follow",
      ),
      label(
        view.bottom.up(14),
        "paletteLens · trait-dispatched Linear + Metric · works the same on Vec, Color, Pose",
        { size: 10 },
      ),
    );
  }
}
