import {
  circle,
  Diagram,
  dragRotate,
  drive,
  label,
  type Mount,
  type Num,
  num,
  Shape,
  signal,
  type Vec,
  vec,
  type Writable,
} from "../../minim";

const TAU = Math.PI * 2;

/** Single-path SVG gear: outer/inner alternating around N teeth. */
function gearPathD(r: number, teeth: number, toothDepth = 3.5): string {
  const inner = r - toothDepth;
  const outer = r + toothDepth;
  const parts: string[] = [];
  const N = teeth * 2;
  for (let i = 0; i < N; i++) {
    const a = (i * Math.PI) / teeth;
    const rad = i % 2 === 0 ? outer : inner;
    parts.push(
      `${i === 0 ? "M" : "L"} ${(rad * Math.cos(a)).toFixed(2)} ${(rad * Math.sin(a)).toFixed(2)}`,
    );
  }
  return `${parts.join(" ")} Z`;
}

/** Gear-shaped Shape — one SVG `<path>`, one rotate signal. */
function gear(center: Vec, radius: number, teeth: number, rotate: Writable<Num>): Shape {
  const r = radius;
  const sh = new Shape("path", () => ({ x: -r, y: -r, w: 2 * r, h: 2 * r }), {
    translate: center,
    rotate,
  });
  sh.attr("d", gearPathD(r, teeth));
  sh.attr("fill", "transparent");
  sh.attr("stroke", "currentColor");
  sh.attr("stroke-width", "1.25");
  sh.attr("stroke-linejoin", "round");
  return sh;
}

export class MdGears extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 320);

    // Pitch (= 2π·r/N) MUST match across meshing gears for the teeth
    // to interlock during rotation, not just statically. Odd teeth
    // counts give a natural tooth-at-0 / valley-at-π pattern, so
    // adjacent gears in a horizontal chain alternate tooth↔valley at
    // their contact points automatically. No per-gear phase offset.
    const teeth = [15, 9, 17];
    const PITCH_K = 3.5; // r = PITCH_K · teeth → matched pitch (= 2π·K).
    const sizes = teeth.map(n => PITCH_K * n); // [52.5, 31.5, 59.5]
    const cy = view.h.value / 2;
    let totalW = 0;
    for (let i = 0; i < sizes.length - 1; i++) totalW += sizes[i] + sizes[i + 1];
    let cx = view.w.value / 2 - totalW / 2;
    const centers: Vec[] = [];
    for (let i = 0; i < sizes.length; i++) {
      if (i > 0) cx += sizes[i - 1] + sizes[i];
      centers.push(vec(cx, cy));
    }

    // Chain ratio is by TEETH count (not radius). For matched pitch
    // these are equal, but parametrising by teeth is what makes the
    // teeth visually interlock during rotation.
    const drive0 = num(0);
    const angles: Writable<Num>[] = [drive0];
    for (let i = 1; i < teeth.length; i++) {
      const sign = i % 2 === 1 ? -1 : 1;
      angles.push(drive0.scale((sign * teeth[0]) / teeth[i]));
    }

    // Pause the drive while any gear is being dragged.
    const dragging = signal(false);
    const omega = TAU * 0.15;
    this.anim.start(
      drive(tick => {
        if (dragging.value) return;
        drive0.value = drive0.peek() + omega * tick.dt;
      }),
    );

    // Render gears, hub dot, and a knob you can drag on the rim.
    for (let i = 0; i < sizes.length; i++) {
      const c = centers[i];
      const r = sizes[i];
      const a = angles[i];

      const g = s(gear(c, r, teeth[i], a));
      s(circle(c, 3, { fill: true }));

      // Drag anywhere on the gear — the click point becomes the
      // ephemeral handle, and `a` is written so that point follows
      // the cursor. Writes propagate through the gear-ratio chain
      // back to drive0 (so dragging any gear scrubs the whole chain).
      dragRotate(g, a, dragging);
    }

    s(
      label(view.top.down(20), "drag any blue knob — the meshed chain rotates everything"),
      label(
        view.bottom.up(16),
        "g[i] = drive.scale(±1 / ratio_i) · invertible chain · drive pauses while dragging",
        { size: 10 },
      ),
    );
  }
}
