// md-curve-bases.ts — one cubic curve, three editable control nets.
//
// A cubic segment is four DOF per axis. Every spline basis is just a
// different coordinate system for the *same* curve, related by a
// constant 4×4 matrix M_b (controls → polynomial coeffs). The canonical
// cell holds the coefficient vectors `a₀..a₃`; each basis's handles are
// a `Vec.lens` onto them via `M_b⁻¹`. Drag a handle in ANY basis and the
// bwd remaps the coeffs through M_b, so every OTHER net's handles jump
// while the shared curve stays invariant — change of basis, made visible.

import {
  circle,
  Diagram,
  derive,
  drag,
  label,
  line,
  type Mount,
  pathD,
  Vec,
  vec,
  type Writable,
} from "../../minim";

type Mat4 = number[][];
type Pt = { x: number; y: number };

/** Apply a 4×4 matrix to four points (component-wise, x and y alike). */
function applyMat(M: Mat4, p: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    let x = 0;
    let y = 0;
    for (let j = 0; j < 4; j++) {
      x += M[i]![j]! * p[j]!.x;
      y += M[i]![j]! * p[j]!.y;
    }
    out.push({ x, y });
  }
  return out;
}

/** 4×4 inverse via Gauss–Jordan (small, exact enough for basis matrices). */
function inv4(M: Mat4): Mat4 {
  const a = M.map((r, i) => [...r, ...[0, 0, 0, 0].map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    [a[col], a[piv]] = [a[piv]!, a[col]!];
    const d = a[col]![col]!;
    for (let k = 0; k < 8; k++) a[col]![k]! /= d;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = a[r]![col]!;
      for (let k = 0; k < 8; k++) a[r]![k]! -= f * a[col]![k]!;
    }
  }
  return a.map(r => r.slice(4));
}

// Control → polynomial-coefficient matrices (p(t) = a₀ + a₁t + a₂t² + a₃t³).
const M_BEZIER: Mat4 = [
  [1, 0, 0, 0],
  [-3, 3, 0, 0],
  [3, -6, 3, 0],
  [-1, 3, -3, 1],
];
const M_CATMULL: Mat4 = [
  [0, 1, 0, 0],
  [-0.5, 0, 0.5, 0],
  [1, -2.5, 2, -0.5],
  [-0.5, 1.5, -1.5, 0.5],
];
const M_BSPLINE: Mat4 = [
  [1 / 6, 4 / 6, 1 / 6, 0],
  [-0.5, 0, 0.5, 0],
  [0.5, -1, 0.5, 0],
  [-1 / 6, 0.5, -0.5, 1 / 6],
];

interface Basis {
  name: string;
  color: string;
  M: Mat4;
  invM: Mat4;
}
const BASES: Basis[] = [
  { name: "Bézier", color: "#5b8def", M: M_BEZIER, invM: inv4(M_BEZIER) },
  { name: "Catmull–Rom", color: "#e2a33c", M: M_CATMULL, invM: inv4(M_CATMULL) },
  { name: "B-spline", color: "#4caf6e", M: M_BSPLINE, invM: inv4(M_BSPLINE) },
];

const W = 640;
const H = 360;
const SAMPLES = 64;

export class MdCurveBases extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    // Canonical = the four coefficient vectors, seeded from a Bézier S.
    const seed: Pt[] = [
      { x: 110, y: 250 },
      { x: 250, y: 80 },
      { x: 410, y: 280 },
      { x: 540, y: 110 },
    ];
    const coeffVals = applyMat(M_BEZIER, seed);
    const coeff = coeffVals.map(c => vec(c.x, c.y)) as [
      Writable<Vec>,
      Writable<Vec>,
      Writable<Vec>,
      Writable<Vec>,
    ];

    // Shared curve: p(t) = Σ aᵢ tⁱ — drawn once from the coeffs.
    const curveD = () => {
      const a = coeff.map(c => c.value);
      let d = "";
      for (let k = 0; k <= SAMPLES; k++) {
        const t = k / SAMPLES;
        const x = a[0]!.x + a[1]!.x * t + a[2]!.x * t * t + a[3]!.x * t ** 3;
        const y = a[0]!.y + a[1]!.y * t + a[2]!.y * t * t + a[3]!.y * t ** 3;
        d += `${k === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)} `;
      }
      return d;
    };
    s(pathD(derive(curveD), { strokeWidth: 2.5 }));

    // Each basis: 4 handles = a Vec.lens onto the coeff vectors via M_b⁻¹.
    for (const basis of BASES) {
      const handles: Writable<Vec>[] = [];
      for (let j = 0; j < 4; j++) {
        const h = Vec.lens(
          coeff,
          (vals: readonly Pt[]) => applyMat(basis.invM, vals)[j]!,
          (target: Pt, vals: readonly Pt[]) => {
            const q = applyMat(basis.invM, vals);
            q[j] = target;
            return applyMat(basis.M, q) as never;
          },
        );
        handles.push(h);
      }

      // Control polygon (thin dashed) + draggable dots.
      for (let j = 0; j < 3; j++) {
        s(
          line(handles[j]!, handles[j + 1]!, { thin: true, stroke: basis.color, dasharray: "3 4" }),
        );
      }
      for (let j = 0; j < 4; j++) {
        const dot = s(circle(handles[j]!, 6, { fill: basis.color, stroke: basis.color }));
        drag(dot, handles[j]!);
      }
    }

    // Legend.
    BASES.forEach((b, i) => {
      s(circle(vec(40, 28 + i * 18), 5, { fill: b.color, stroke: b.color }));
      s(label(vec(52, 28 + i * 18), b.name, { size: 12, align: { x: 0, y: 0.5 }, fill: b.color }));
    });

    s(
      label(
        view.bottom.up(16),
        "one curve, three coordinate systems · handle = Vec.lens(coeffs, M⁻¹, M) · drag any net; the curve is invariant",
        { size: 10 },
      ),
    );
  }
}
