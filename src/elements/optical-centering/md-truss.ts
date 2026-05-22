// md-truss.ts — position-based-dynamics constraint network.
//
// All joints are writable Vecs. All bars are length-residual
// constraints. Each frame the solver does a few Gauss–Seidel
// projections of every joint pair onto its bar's manifold; in steady
// state the residuals are zero and every constraint is satisfied.
// Drag any joint, the solver propagates the residual to the rest —
// the same primitive does forward and inverse, no branch decisions
// anywhere.
//
// Mechanism: planar 5-bar parallel manipulator. Two ground pivots
// (O1, O2), two crank-arm joints (A, B), one end-effector E meeting
// both forearms. Two DOF — drag E and both arms reconfigure
// simultaneously, or drag A or B and watch the closed-loop redistribute.

import {
  Anchor,
  circle,
  Diagram,
  drive,
  handle,
  label,
  line,
  Mount,
  type Of,
  signal,
  Vec,
  vec,
  type Writable,
} from "../../minim";

type V = Of<Vec>;

interface TrussSpec<K extends string> {
  joints: Record<K, V>;
  bars: ReadonlyArray<{ from: K; to: K; length: number }>;
  fixed?: ReadonlyArray<K>;
  iterations?: number;
}

interface Truss<K extends string> {
  joints: Record<K, Writable<Vec>>;
  /** Run one PBD relaxation pass. `pin` lets the caller mark joints
   *  as temporarily fixed (e.g. the one currently being dragged), so
   *  the dragged joint leads and the rest follow. */
  step(pin?: ReadonlySet<K>): void;
}

function truss<K extends string>(spec: TrussSpec<K>): Truss<K> {
  const iterations = spec.iterations ?? 8;
  const joints = {} as Record<K, Writable<Vec>>;
  for (const k of Object.keys(spec.joints) as K[]) {
    joints[k] = vec(spec.joints[k].x, spec.joints[k].y);
  }
  const baseFixed = new Set<K>(spec.fixed ?? []);

  const step = (pin?: ReadonlySet<K>): void => {
    for (let iter = 0; iter < iterations; iter++) {
      for (const bar of spec.bars) {
        const a = joints[bar.from];
        const b = joints[bar.to];
        const av = a.peek();
        const bv = b.peek();
        const dx = bv.x - av.x;
        const dy = bv.y - av.y;
        const d = Math.hypot(dx, dy);
        if (d < 1e-9) continue;
        const fixA = baseFixed.has(bar.from) || (pin?.has(bar.from) ?? false);
        const fixB = baseFixed.has(bar.to) || (pin?.has(bar.to) ?? false);
        const wA = fixA ? 0 : 1;
        const wB = fixB ? 0 : 1;
        const wTotal = wA + wB;
        if (wTotal === 0) continue;
        const k = (d - bar.length) / d;
        if (wA) a.value = { x: av.x + (k * wA * dx) / wTotal, y: av.y + (k * wA * dy) / wTotal };
        if (wB) b.value = { x: bv.x - (k * wB * dx) / wTotal, y: bv.y - (k * wB * dy) / wTotal };
      }
    }
  };

  return { joints, step };
}

const ARM = 90;
const FORE = 110;
const SPAN = 200;

export class MdTruss extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);

    const cx = view.center.value.x;
    const baseY = view.center.value.y + 90;

    const t = truss({
      joints: {
        O1: { x: cx - SPAN / 2, y: baseY },
        O2: { x: cx + SPAN / 2, y: baseY },
        A: { x: cx - SPAN / 2, y: baseY - ARM },
        B: { x: cx + SPAN / 2, y: baseY - ARM },
        E: { x: cx, y: baseY - ARM - 30 },
      },
      bars: [
        { from: "O1", to: "A", length: ARM },
        { from: "O2", to: "B", length: ARM },
        { from: "A", to: "E", length: FORE },
        { from: "B", to: "E", length: FORE },
      ],
      fixed: ["O1", "O2"],
      iterations: 10,
    });

    const { O1, O2, A, B, E } = t.joints;

    s(
      line(O1, A, { thin: true }),
      line(O2, B, { thin: true }),
      line(A, E, { thin: true }),
      line(B, E, { thin: true }),
    );

    s(circle(O1, 4, { fill: true }), circle(O2, 4, { fill: true }));

    const aH = s(handle(A, { fill: "#5b8def", r: 7 }));
    const bH = s(handle(B, { fill: "#5b8def", r: 7 }));
    const eH = s(handle(E, { fill: "#e25c5c", r: 8 }));

    // Drift target for the auto-animation when no handle is dragged —
    // a slowly orbiting point inside the workspace; PBD propagates
    // its writes through to A and B each frame.
    const phase = signal(0);

    this.anim.start(
      drive(tick => {
        const pin = new Set<"O1" | "O2" | "A" | "B" | "E">();
        if (aH.dragging.value) pin.add("A");
        if (bH.dragging.value) pin.add("B");
        if (eH.dragging.value) pin.add("E");
        if (pin.size === 0) {
          phase.value = phase.peek() + tick.dt * 0.55;
          E.value = {
            x: cx + 70 * Math.cos(phase.value),
            y: baseY - ARM - 40 + 35 * Math.sin(phase.value * 1.3),
          };
          pin.add("E");
        }
        t.step(pin);
      }),
    );

    s(
      label(view.top.down(20), "drag any joint — every bar length stays preserved", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        "5-bar parallel manipulator · 4 length constraints · solver = position-based-dynamics relaxation",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
