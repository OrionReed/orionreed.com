// cell.ts — vertex / cell type for the AVBD solver.
//
// Each Cell holds per-vertex state. `dim` is the cell's number of
// degrees of freedom (Num=1, Vec=2, Box=4, …). The local Newton
// solve operates on a `dim × dim` system.
//
// Naming follows the AVBD paper:
//
//   position  — `x`, current value (what the solver writes).
//   initial   — `x⁻`, snapshot at start of timestep.
//   inertial  — `y`, warm-start anchor; the inertia term pulls
//               position toward this. Static mode: y = x⁻.
//               Physics mode: y = x⁻ + h·v + h²·a_ext.
//   velocity  — physics-mode-only; static mode ignores it.
//   mass      — regularisation weight. `1` = mild Tikhonov
//               regularisation; `0` = kinematic / pinned.
//
// User-facing factories (`num`, `vec`, `box` — see below) wrap
// `Cell` with typed `value` accessors so consumers can write
// `point.value = { x: 3, y: 4 }` instead of `point.position[0] = 3;
// point.position[1] = 4`. The bare `Cell` class is kept for the
// solver's hot path and for users wanting raw `dim`-D access.

import type { Force } from "./force";

export class Cell {
  /** Number of degrees of freedom. */
  readonly dim: number;
  /** Current position. The solver writes here directly. */
  readonly position: Float64Array;
  /** Position at start of timestep (`x⁻`). Solver-managed. */
  readonly initial: Float64Array;
  /** Warm-start anchor (`y`). Solver-managed. */
  readonly inertial: Float64Array;
  /** Velocity at end of last timestep. Physics-mode only. */
  readonly velocity: Float64Array;
  /** Previous-step velocity, for paper §3.7 adaptive warm-start.
   *  Reserved for future physics-mode improvements. */
  readonly prevVelocity: Float64Array;
  /** Inertia-term weight. Default 1; `0` = kinematic / pinned
   *  (primal update is skipped, value stays put). */
  mass: number;
  /** Forces incident to this cell. */
  readonly forces: Force[] = [];
  /** For each entry in `forces`, this cell's index within
   *  `force.cells`. Avoids `indexOf` in the hot loop. */
  readonly forceCellIdx: number[] = [];

  constructor(dim: number, initial?: ArrayLike<number>) {
    this.dim = dim;
    this.position = new Float64Array(dim);
    this.initial = new Float64Array(dim);
    this.inertial = new Float64Array(dim);
    this.velocity = new Float64Array(dim);
    this.prevVelocity = new Float64Array(dim);
    this.mass = 1;
    if (initial) {
      for (let i = 0; i < dim; i++) {
        const v = initial[i] ?? 0;
        this.position[i] = v;
        this.initial[i] = v;
        this.inertial[i] = v;
      }
    }
  }
}

// ─── Typed cell subclasses ──────────────────────────────────────────
//
// Convenience subclasses with `value` getters/setters so consumers
// can use ergonomic typed access. The solver still operates on
// `position` directly (bypassing the getter) for hot-path speed.

/** Scalar cell: dim=1. Use `cell.value` to read/write the number. */
export class NumCell extends Cell {
  constructor(initial: number = 0) {
    super(1, [initial]);
  }
  get value(): number {
    return this.position[0]!;
  }
  set value(v: number) {
    this.position[0]! = v;
  }
}

/** Vector cell: dim=2. Read/write via `.value` (`{x, y}`) or `.x`/`.y`. */
export class VecCell extends Cell {
  constructor(x: number = 0, y: number = 0) {
    super(2, [x, y]);
  }
  get value(): { x: number; y: number } {
    return { x: this.position[0]!, y: this.position[1]! };
  }
  set value(v: { x: number; y: number }) {
    this.position[0]! = v.x;
    this.position[1]! = v.y;
  }
  get x(): number {
    return this.position[0]!;
  }
  set x(v: number) {
    this.position[0]! = v;
  }
  get y(): number {
    return this.position[1]!;
  }
  set y(v: number) {
    this.position[1]! = v;
  }
}

/** Box cell: dim=4 (`x, y, w, h`). */
export class BoxCell extends Cell {
  constructor(x: number = 0, y: number = 0, w: number = 0, h: number = 0) {
    super(4, [x, y, w, h]);
  }
  get value(): { x: number; y: number; w: number; h: number } {
    return {
      x: this.position[0]!,
      y: this.position[1]!,
      w: this.position[2]!,
      h: this.position[3]!,
    };
  }
  set value(v: { x: number; y: number; w: number; h: number }) {
    this.position[0]! = v.x;
    this.position[1]! = v.y;
    this.position[2]! = v.w;
    this.position[3]! = v.h;
  }
}

/** Construct a `NumCell` initialised at `v`. */
export function num(v: number = 0): NumCell {
  return new NumCell(v);
}
/** Construct a `VecCell` initialised at `(x, y)`. */
export function vec(x: number = 0, y: number = 0): VecCell {
  return new VecCell(x, y);
}
/** Construct a `BoxCell` initialised at `(x, y, w, h)`. */
export function box(x = 0, y = 0, w = 0, h = 0): BoxCell {
  return new BoxCell(x, y, w, h);
}
