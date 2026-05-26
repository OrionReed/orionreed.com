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
// Mechanism: 3-armed planar Stewart platform. Three ground pivots
// (fixed) drive three elbow joints; three forearm bars meet a rigid
// triangular platform held together by three internal bars. Nine
// length constraints, three platform DOF. Drag any platform corner
// or elbow and the closed-loop redistributes through the whole rig.

import {
  circle,
  Diagram,
  drive,
  handle,
  label,
  line,
  Mount,
  type Of,
  Path,
  signal,
  Vec,
  vec,
  type Writable,
} from "../../minim";

type V = Of<Vec>;

const TAU = Math.PI * 2;

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

const R_GROUND = 130;
const R_PLAT = 55;
const ARM = 90;
const FORE = 85;
const BASE = -Math.PI / 2; // first ground / platform vertex points up

type Key = "O1" | "O2" | "O3" | "A1" | "A2" | "A3" | "P1" | "P2" | "P3";

export class MdTruss extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 460);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const triPoint = (r: number, i: number): V => {
      const a = BASE + (i * TAU) / 3;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    };

    const Os = [0, 1, 2].map(i => triPoint(R_GROUND, i));
    const Ps = [0, 1, 2].map(i => triPoint(R_PLAT, i));

    // Initial elbows offset perpendicular-CCW from the leg midpoint
    // so the rig starts on a consistent branch.
    const As = [0, 1, 2].map(i => {
      const O = Os[i];
      const P = Ps[i];
      const dx = P.x - O.x;
      const dy = P.y - O.y;
      const len = Math.hypot(dx, dy);
      return {
        x: (O.x + P.x) / 2 - 25 * (dy / len),
        y: (O.y + P.y) / 2 + 25 * (dx / len),
      };
    });

    const platSide = Math.hypot(Ps[1].x - Ps[0].x, Ps[1].y - Ps[0].y);

    const t = truss({
      joints: {
        O1: Os[0],
        O2: Os[1],
        O3: Os[2],
        A1: As[0],
        A2: As[1],
        A3: As[2],
        P1: Ps[0],
        P2: Ps[1],
        P3: Ps[2],
      },
      bars: [
        { from: "O1", to: "A1", length: ARM },
        { from: "O2", to: "A2", length: ARM },
        { from: "O3", to: "A3", length: ARM },
        { from: "A1", to: "P1", length: FORE },
        { from: "A2", to: "P2", length: FORE },
        { from: "A3", to: "P3", length: FORE },
        { from: "P1", to: "P2", length: platSide },
        { from: "P2", to: "P3", length: platSide },
        { from: "P3", to: "P1", length: platSide },
      ],
      fixed: ["O1", "O2", "O3"],
      iterations: 16,
    });

    const { O1, O2, O3, A1, A2, A3, P1, P2, P3 } = t.joints;

    // Faint base triangle joining the three ground pivots — purely
    // visual, not a constraint.
    s(
      line(O1, O2, { thin: true, opacity: 0.18 }),
      line(O2, O3, { thin: true, opacity: 0.18 }),
      line(O3, O1, { thin: true, opacity: 0.18 }),
    );

    // Six leg bars (3 upper + 3 forearm).
    s(
      line(O1, A1, { thin: true }),
      line(O2, A2, { thin: true }),
      line(O3, A3, { thin: true }),
      line(A1, P1, { thin: true }),
      line(A2, P2, { thin: true }),
      line(A3, P3, { thin: true }),
    );

    // Rigid platform triangle as a closed filled Path.
    s(
      new Path([P1, P2, P3], {
        closed: true,
        fill: "rgba(226, 92, 92, 0.22)",
        stroke: "#e25c5c",
        strokeWidth: 1.6,
      }),
    );

    s(circle(O1, 4, { fill: true }), circle(O2, 4, { fill: true }), circle(O3, 4, { fill: true }));

    const a1H = s(handle(A1, { fill: "#5b8def", r: 6 }));
    const a2H = s(handle(A2, { fill: "#5b8def", r: 6 }));
    const a3H = s(handle(A3, { fill: "#5b8def", r: 6 }));
    const p1H = s(handle(P1, { fill: "#e25c5c", r: 7 }));
    const p2H = s(handle(P2, { fill: "#e25c5c", r: 7 }));
    const p3H = s(handle(P3, { fill: "#e25c5c", r: 7 }));

    // Auto-orbit of the platform pose when no handle is dragged. All
    // three platform corners get written each frame to a Lissajous
    // centre + slowly oscillating rotation, then pinned during the
    // step so PBD only relaxes the elbows.
    const phase = signal(0);

    this.anim.start(
      drive(tick => {
        const pin = new Set<Key>();
        if (a1H.dragging.value) pin.add("A1");
        if (a2H.dragging.value) pin.add("A2");
        if (a3H.dragging.value) pin.add("A3");
        if (p1H.dragging.value) pin.add("P1");
        if (p2H.dragging.value) pin.add("P2");
        if (p3H.dragging.value) pin.add("P3");
        if (pin.size === 0) {
          phase.value = phase.peek() + tick.dt * 0.55;
          const ph = phase.value;
          const cxP = cx + 32 * Math.cos(ph);
          const cyP = cy + 22 * Math.sin(ph * 1.3);
          const rot = 0.32 * Math.sin(ph * 0.6);
          for (let i = 0; i < 3; i++) {
            const a = BASE + (i * TAU) / 3 + rot;
            const key = `P${i + 1}` as "P1" | "P2" | "P3";
            t.joints[key].value = {
              x: cxP + R_PLAT * Math.cos(a),
              y: cyP + R_PLAT * Math.sin(a),
            };
          }
          pin.add("P1");
          pin.add("P2");
          pin.add("P3");
        }
        t.step(pin);
      }),
    );

    s(
      label(view.top.down(20), "drag any platform corner or elbow — all three arms reconfigure"),
      label(
        view.bottom.up(16),
        "3-armed planar Stewart platform · 9 length constraints · solver = position-based dynamics",
      ),
    );
  }
}
