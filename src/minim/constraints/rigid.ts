// rigid.ts — 2D rigid-body relations + box-box collision.
//
// A rigid body is a 3-DOF cell `(x, y, θ)` with diagonal mass
// `(m, m, I)`. Geometry and broadphase bookkeeping live on a `Body`
// wrapper. Box-box collisions generate a `BoxContact` term with
// normal + tangential rows and feature-pair tracking for static
// friction.
//
// `Body`, `Joint`, and `BodyAnchor` are `Relation`s — add via
// `c.add(...)`, typically inside a `world()` factory.
//
// SAT collision is a port of Box2D-Lite's box-box collide (MIT,
// Erin Catto), as used by the AVBD 2D reference. See:
// https://github.com/savant117/avbd-demo2d/blob/main/source/collide.cpp

import {
  isSignal,
  Num,
  num as numSig,
  type Pose,
  pose as poseSig,
  Vec,
  vec,
  type Writable,
} from "../signals";
import type { Constraints, Relation } from "./cluster";
import type { Solver } from "./solver";
import { Term } from "./term";

const COLLISION_MARGIN = 0.0005;
const STICK_THRESH = 0.01;

export interface BodyOpts {
  /** Box width (x extent) and height (y extent). */
  size: { w: number; h: number };
  /** Mass per unit area. `0` makes the body static (pinned, infinite
   *  mass). Default `1`. */
  density?: number;
  /** Friction coefficient. Two bodies' coefficients combine as the
   *  geometric mean. Default `0.5`. */
  friction?: number;
}

export interface BodyInit {
  x: number;
  y: number;
  theta?: number;
}

/** A 2D rigid body (a `Relation`; add via `world.add(body)`).
 *
 *  Pose is one `Pose` signal; `position` (Vec) and `angle` (Num) are
 *  lenses on it for consumers wanting a narrower view. `cellId` is the
 *  solver cell after `bind` (-1 before). */
export class Body implements Relation {
  readonly w: number;
  readonly h: number;
  readonly mass: number;
  readonly moment: number;
  readonly friction: number;
  /** Bounding radius for the broadphase. */
  readonly radius: number;

  /** Reactive pose — single source of truth, updated each tick. */
  readonly pose: Writable<Pose>;
  /** Vec lens on `pose` (xy); writes propagate back through `pose`. */
  readonly position: Writable<Vec>;
  /** Num lens on `pose` (theta). */
  readonly angle: Writable<Num>;

  /** Solver cell id; -1 until `bind` runs. */
  cellId = -1;
  /** @internal — set on bind so force code can read solver state. */
  _solver?: Solver;

  constructor(opts: BodyOpts, init: BodyInit) {
    this.w = opts.size.w;
    this.h = opts.size.h;
    const density = opts.density ?? 1;
    const area = this.w * this.h;
    this.mass = density === 0 ? 0 : area * density;
    this.moment = density === 0 ? 0 : (this.mass * (this.w * this.w + this.h * this.h)) / 12;
    this.friction = opts.friction ?? 0.5;
    this.radius = Math.hypot(this.w * 0.5, this.h * 0.5);

    this.pose = poseSig({ x: init.x, y: init.y, theta: init.theta ?? 0 });

    // Position lens — Vec view of (pose.x, pose.y); writes preserve theta.
    this.position = Vec.lens(
      this.pose,
      p => ({ x: p.x, y: p.y }),
      (v, p) => ({ x: v.x, y: v.y, theta: p.theta }),
    );
    // Angle lens — Num view of pose.theta; writes preserve xy.
    this.angle = Num.lens(
      this.pose,
      p => p.theta,
      (t, p) => ({ x: p.x, y: p.y, theta: t }),
    );
  }

  bind(c: Constraints): () => void {
    if (this.cellId >= 0) throw new Error("Body: already bound");
    this.cellId = c._bind(this.pose);
    this._solver = c.solver;
    if (this.mass === 0) c.solver.setMass(this.cellId, 0);
    else c.solver.setMassDiag(this.cellId, [this.mass, this.mass, this.moment]);
    return () => {
      // Solver cells are append-only; can't free. Mark kinematic and
      // forget cellId so the body could be re-bound elsewhere.
      c.solver.setMass(this.cellId, 0);
      this.cellId = -1;
      this._solver = undefined;
    };
  }

  /** Relation that pins this body (mass → 0, kinematic) while
   *  attached; restores `(m, m, I)` on detach. Composes with
   *  `addWhile` for drag. The pose still updates from
   *  `body.position` / `body.angle` writes. */
  pin(): Relation {
    const body = this;
    return {
      bind(c: Constraints) {
        if (body.cellId < 0) throw new Error("body.pin: add the body first");
        const wasStatic = body.mass === 0;
        c.solver.setMass(body.cellId, 0);
        return () => {
          if (!wasStatic) {
            c.solver.setMassDiag(body.cellId, [body.mass, body.mass, body.moment]);
          }
        };
      },
    };
  }
}

/** Create a rigid body (add via `world.add`). `density: 0` is static
 *  (mass 0, kinematic cell). */
export function body(opts: BodyOpts, init: BodyInit): Body {
  return new Body(opts, init);
}

// ─── Pose buffer reads (hot path, alloc-free) ──────────────────────

interface PoseScratch {
  x: number;
  y: number;
  theta: number;
}

/** @internal — Read live solver position into `out`. The `pose`
 *  signal holds the start-of-tick value; the live value during
 *  iteration is in `solver.positions`. For inner-loop use. */
function readPose(solver: Solver, cellId: number, out: PoseScratch): void {
  const off = solver.offsets[cellId]!;
  const p = solver.positions;
  out.x = p[off]!;
  out.y = p[off + 1]!;
  out.theta = p[off + 2]!;
}

// ─── SAT box-box collision ──────────────────────────────────────────

/** Edge identifiers for feature-pair tracking. */
const enum Edge {
  None = 0,
  E1 = 1, // top
  E2 = 2, // left
  E3 = 3, // bottom
  E4 = 4, // right
}

interface ClipVertex {
  x: number;
  y: number;
  /** 32-bit packed (inEdge1, outEdge1, inEdge2, outEdge2). */
  fp: number;
}

const enum Axis {
  FaceAX = 0,
  FaceAY = 1,
  FaceBX = 2,
  FaceBY = 3,
}

function makeFP(inE1: number, outE1: number, inE2: number, outE2: number): number {
  return (inE1 & 0xff) | ((outE1 & 0xff) << 8) | ((inE2 & 0xff) << 16) | ((outE2 & 0xff) << 24);
}

function flipFP(fp: number): number {
  // Swap (inE1, outE1) with (inE2, outE2).
  const inE1 = fp & 0xff;
  const outE1 = (fp >> 8) & 0xff;
  const inE2 = (fp >> 16) & 0xff;
  const outE2 = (fp >> 24) & 0xff;
  return makeFP(inE2, outE2, inE1, outE1);
}

/** Clip segment `vIn` to the half-plane `n · v ≤ offset`. A bisected
 *  segment's new vertex inherits the clipped endpoint's feature pair,
 *  overwriting edge-1 with `clipEdge` per Box2D-Lite. Stable feature
 *  pairs are what let penalty / λ warm-start through sliding contacts. */
function clipSegmentToLine(
  vOut: ClipVertex[],
  vIn: ClipVertex[],
  nx: number,
  ny: number,
  offset: number,
  clipEdge: Edge,
): number {
  let n = 0;
  const d0 = nx * vIn[0]!.x + ny * vIn[0]!.y - offset;
  const d1 = nx * vIn[1]!.x + ny * vIn[1]!.y - offset;
  if (d0 <= 0) vOut[n++] = vIn[0]!;
  if (d1 <= 0) vOut[n++] = vIn[1]!;
  if (d0 * d1 < 0) {
    const t = d0 / (d0 - d1);
    const x = vIn[0]!.x + (vIn[1]!.x - vIn[0]!.x) * t;
    const y = vIn[0]!.y + (vIn[1]!.y - vIn[0]!.y) * t;
    let fp: number;
    if (d0 > 0) {
      // vIn[0] was on the wrong side. Inherit fp from vIn[0] but
      // overwrite inEdge1 with clipEdge and clear inEdge2.
      const src = vIn[0]!.fp;
      const outE1 = (src >> 8) & 0xff;
      const outE2 = (src >> 24) & 0xff;
      fp = makeFP(clipEdge, outE1, Edge.None, outE2);
    } else {
      // vIn[1] was on the wrong side. Inherit fp from vIn[1] but
      // overwrite outEdge1 with clipEdge and clear outEdge2.
      const src = vIn[1]!.fp;
      const inE1 = src & 0xff;
      const inE2 = (src >> 16) & 0xff;
      fp = makeFP(inE1, clipEdge, inE2, Edge.None);
    }
    vOut[n++] = { x, y, fp };
  }
  return n;
}

/** Compute the incident edge of box B that opposes the chosen face
 *  of box A. Output two clip vertices in world space. */
function computeIncidentEdge(
  c: ClipVertex[],
  hx: number,
  hy: number,
  posX: number,
  posY: number,
  cosT: number,
  sinT: number,
  nx: number,
  ny: number,
): void {
  // Convert normal to incident-frame and flip.
  const ln = -(cosT * nx + sinT * ny);
  const lny = -(-sinT * nx + cosT * ny);
  const absX = Math.abs(ln);
  const absY = Math.abs(lny);

  let v0x: number, v0y: number, v1x: number, v1y: number;
  let fp0: number, fp1: number;
  if (absX > absY) {
    if (ln > 0) {
      v0x = hx;
      v0y = -hy;
      v1x = hx;
      v1y = hy;
      fp0 = makeFP(0, 0, Edge.E3, Edge.E4);
      fp1 = makeFP(0, 0, Edge.E4, Edge.E1);
    } else {
      v0x = -hx;
      v0y = hy;
      v1x = -hx;
      v1y = -hy;
      fp0 = makeFP(0, 0, Edge.E1, Edge.E2);
      fp1 = makeFP(0, 0, Edge.E2, Edge.E3);
    }
  } else {
    if (lny > 0) {
      v0x = hx;
      v0y = hy;
      v1x = -hx;
      v1y = hy;
      fp0 = makeFP(0, 0, Edge.E4, Edge.E1);
      fp1 = makeFP(0, 0, Edge.E1, Edge.E2);
    } else {
      v0x = -hx;
      v0y = -hy;
      v1x = hx;
      v1y = -hy;
      fp0 = makeFP(0, 0, Edge.E2, Edge.E3);
      fp1 = makeFP(0, 0, Edge.E3, Edge.E4);
    }
  }
  c[0]!.x = posX + cosT * v0x - sinT * v0y;
  c[0]!.y = posY + sinT * v0x + cosT * v0y;
  c[0]!.fp = fp0;
  c[1]!.x = posX + cosT * v1x - sinT * v1y;
  c[1]!.y = posY + sinT * v1x + cosT * v1y;
  c[1]!.fp = fp1;
}

interface Contact {
  /** Penetration anchor on body A in A's local frame. */
  rAx: number;
  rAy: number;
  /** Penetration anchor on body B in B's local frame. */
  rBx: number;
  rBy: number;
  /** World-frame contact normal pointing A → B. */
  nx: number;
  ny: number;
  /** Feature-pair (edge IDs) for warm-starting across frames. */
  fp: number;
  /** Whether the contact was sticking (static friction) last frame. */
  stick: boolean;
}

function makeContact(): Contact {
  return { rAx: 0, rAy: 0, rBx: 0, rBy: 0, nx: 0, ny: 0, fp: 0, stick: false };
}

/** Collide two oriented boxes. Returns the number of contacts (0–2)
 *  written into `out`. Direct port of Box2D-Lite (Catto, MIT). */
function collideBoxes(
  out: Contact[],
  posA: { x: number; y: number; theta: number },
  hA: { w: number; h: number },
  posB: { x: number; y: number; theta: number },
  hB: { w: number; h: number },
): number {
  const hAx = hA.w * 0.5;
  const hAy = hA.h * 0.5;
  const hBx = hB.w * 0.5;
  const hBy = hB.h * 0.5;

  const cA = Math.cos(posA.theta);
  const sA = Math.sin(posA.theta);
  const cB = Math.cos(posB.theta);
  const sB = Math.sin(posB.theta);

  // dA = RotAᵀ · (posB - posA), dB = RotBᵀ · (posB - posA)
  const dpx = posB.x - posA.x;
  const dpy = posB.y - posA.y;
  const dAx = cA * dpx + sA * dpy;
  const dAy = -sA * dpx + cA * dpy;
  const dBx = cB * dpx + sB * dpy;
  const dBy = -sB * dpx + cB * dpy;

  // C = RotAᵀ · RotB (relative rotation).
  const c00 = cA * cB + sA * sB;
  const c01 = -cA * sB + sA * cB;
  const c10 = -sA * cB + cA * sB;
  const c11 = sA * sB + cA * cB;
  const ac00 = Math.abs(c00);
  const ac01 = Math.abs(c01);
  const ac10 = Math.abs(c10);
  const ac11 = Math.abs(c11);

  // Box A faces: |dA| − hA − |C| · hB
  const faceAX = Math.abs(dAx) - hAx - (ac00 * hBx + ac01 * hBy);
  const faceAY = Math.abs(dAy) - hAy - (ac10 * hBx + ac11 * hBy);
  if (faceAX > 0 || faceAY > 0) return 0;

  // Box B faces: |dB| − |Cᵀ| · hA − hB
  const faceBX = Math.abs(dBx) - (ac00 * hAx + ac10 * hAy) - hBx;
  const faceBY = Math.abs(dBy) - (ac01 * hAx + ac11 * hAy) - hBy;
  if (faceBX > 0 || faceBY > 0) return 0;

  // Pick the best axis with bias toward A (relative + absolute tol).
  let axis: Axis = Axis.FaceAX;
  let separation = faceAX;
  let nx = dAx > 0 ? cA : -cA;
  let ny = dAx > 0 ? sA : -sA;

  const RT = 0.95;
  const AT = 0.01;
  if (faceAY > RT * separation + AT * hAy) {
    axis = Axis.FaceAY;
    separation = faceAY;
    nx = dAy > 0 ? -sA : sA;
    ny = dAy > 0 ? cA : -cA;
  }
  if (faceBX > RT * separation + AT * hBx) {
    axis = Axis.FaceBX;
    separation = faceBX;
    nx = dBx > 0 ? cB : -cB;
    ny = dBx > 0 ? sB : -sB;
  }
  if (faceBY > RT * separation + AT * hBy) {
    axis = Axis.FaceBY;
    separation = faceBY;
    nx = dBy > 0 ? -sB : sB;
    ny = dBy > 0 ? cB : -cB;
  }

  // Setup clipping based on axis.
  let frontNx: number, frontNy: number;
  let sideNx: number, sideNy: number;
  let front: number;
  let negSide: number, posSide: number;
  let negEdge: Edge, posEdge: Edge;
  const incidentEdge: ClipVertex[] = [
    { x: 0, y: 0, fp: 0 },
    { x: 0, y: 0, fp: 0 },
  ];

  if (axis === Axis.FaceAX) {
    frontNx = nx;
    frontNy = ny;
    front = posA.x * frontNx + posA.y * frontNy + hAx;
    sideNx = -sA;
    sideNy = cA;
    const side = posA.x * sideNx + posA.y * sideNy;
    negSide = -side + hAy;
    posSide = side + hAy;
    negEdge = Edge.E3;
    posEdge = Edge.E1;
    computeIncidentEdge(incidentEdge, hBx, hBy, posB.x, posB.y, cB, sB, frontNx, frontNy);
  } else if (axis === Axis.FaceAY) {
    frontNx = nx;
    frontNy = ny;
    front = posA.x * frontNx + posA.y * frontNy + hAy;
    sideNx = cA;
    sideNy = sA;
    const side = posA.x * sideNx + posA.y * sideNy;
    negSide = -side + hAx;
    posSide = side + hAx;
    negEdge = Edge.E2;
    posEdge = Edge.E4;
    computeIncidentEdge(incidentEdge, hBx, hBy, posB.x, posB.y, cB, sB, frontNx, frontNy);
  } else if (axis === Axis.FaceBX) {
    frontNx = -nx;
    frontNy = -ny;
    front = posB.x * frontNx + posB.y * frontNy + hBx;
    sideNx = -sB;
    sideNy = cB;
    const side = posB.x * sideNx + posB.y * sideNy;
    negSide = -side + hBy;
    posSide = side + hBy;
    negEdge = Edge.E3;
    posEdge = Edge.E1;
    computeIncidentEdge(incidentEdge, hAx, hAy, posA.x, posA.y, cA, sA, frontNx, frontNy);
  } else {
    frontNx = -nx;
    frontNy = -ny;
    front = posB.x * frontNx + posB.y * frontNy + hBy;
    sideNx = cB;
    sideNy = sB;
    const side = posB.x * sideNx + posB.y * sideNy;
    negSide = -side + hBx;
    posSide = side + hBx;
    negEdge = Edge.E2;
    posEdge = Edge.E4;
    computeIncidentEdge(incidentEdge, hAx, hAy, posA.x, posA.y, cA, sA, frontNx, frontNy);
  }

  // Clip the incident edge to the side planes.
  const clip1: ClipVertex[] = [
    { x: 0, y: 0, fp: 0 },
    { x: 0, y: 0, fp: 0 },
  ];
  const clip2: ClipVertex[] = [
    { x: 0, y: 0, fp: 0 },
    { x: 0, y: 0, fp: 0 },
  ];
  let np = clipSegmentToLine(clip1, incidentEdge, -sideNx, -sideNy, negSide, negEdge);
  if (np < 2) return 0;
  np = clipSegmentToLine(clip2, clip1, sideNx, sideNy, posSide, posEdge);
  if (np < 2) return 0;

  // Convert clipped points to contacts.
  let count = 0;
  for (let i = 0; i < 2; i++) {
    const cp = clip2[i]!;
    const sep = frontNx * cp.x + frontNy * cp.y - front;
    if (sep <= 0) {
      const c = out[count]!;
      c.nx = -nx;
      c.ny = -ny;
      // rA = RotAᵀ · (cp − frontN·sep − posA), rB = RotBᵀ · (cp − posB)
      // For B-faces, swap rA and rB.
      const useBFace = axis === Axis.FaceBX || axis === Axis.FaceBY;
      const cpAdjX = cp.x - (useBFace ? 0 : frontNx * sep);
      const cpAdjY = cp.y - (useBFace ? 0 : frontNy * sep);
      const cpAdjBX = cp.x - (useBFace ? frontNx * sep : 0);
      const cpAdjBY = cp.y - (useBFace ? frontNy * sep : 0);
      const dAxRel = cpAdjX - posA.x;
      const dAyRel = cpAdjY - posA.y;
      c.rAx = cA * dAxRel + sA * dAyRel;
      c.rAy = -sA * dAxRel + cA * dAyRel;
      const dBxRel = cpAdjBX - posB.x;
      const dByRel = cpAdjBY - posB.y;
      c.rBx = cB * dBxRel + sB * dByRel;
      c.rBy = -sB * dBxRel + cB * dByRel;
      c.fp = useBFace ? flipFP(cp.fp) : cp.fp;
      count++;
    }
  }
  return count;
}

// ─── Manifold (contact) Force ───────────────────────────────────────

const SCRATCH_CONTACTS: Contact[] = [makeContact(), makeContact()];

/** Up to 2 contacts × (normal + tangent) = 4 rows. Coulomb friction
 *  via clamping tangential `λ` to the cone `±μ·|λ_normal|` (updated
 *  per iteration). Truncated Taylor at `x⁻` (paper §4), so `J` is
 *  precomputed in `initialize` and copied out by `computeDerivatives`. */
export class BoxContact extends Term {
  bodyA: Body;
  bodyB: Body;
  numContacts = 0;
  contacts: Contact[] = [makeContact(), makeContact()];
  // Precomputed Jacobians for the 4 possible rows.
  // Each is a 3-vector (∂C/∂x, ∂C/∂y, ∂C/∂θ) per body.
  private JAn: Float64Array; // normal Jacobians on A (3 per contact)
  private JBn: Float64Array; // normal Jacobians on B
  private JAt: Float64Array; // tangential Jacobians on A
  private JBt: Float64Array; // tangential Jacobians on B
  private C0n: Float64Array; // normal C0 per contact
  private C0t: Float64Array; // tangential C0 per contact
  private friction: number = 0;
  // Scratch for live-buffer pose reads (alloc-free hot path).
  private _poseA: PoseScratch = { x: 0, y: 0, theta: 0 };
  private _poseB: PoseScratch = { x: 0, y: 0, theta: 0 };

  constructor(solver: Solver, bodyA: Body, bodyB: Body) {
    super(solver, [bodyA.cellId, bodyB.cellId], 4);
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.JAn = new Float64Array(6); // 2 contacts × 3 components
    this.JBn = new Float64Array(6);
    this.JAt = new Float64Array(6);
    this.JBt = new Float64Array(6);
    this.C0n = new Float64Array(2);
    this.C0t = new Float64Array(2);
    // Normal rows: lambda ≤ 0 (push apart). fmin = -∞, fmax = 0.
    this.lambdaMax[0]! = 0;
    this.lambdaMax[2]! = 0;
    // Tangential rows: friction cone is set per-iteration in computeConstraint.
  }

  initialize(): boolean {
    this.friction = Math.sqrt(this.bodyA.friction * this.bodyB.friction);

    // Stash old contact state for warm-starting.
    const oldContacts: Contact[] = [{ ...this.contacts[0]! }, { ...this.contacts[1]! }];
    const oldNumContacts = this.numContacts;
    const oldPenalty = [this.penalty[0]!, this.penalty[1]!, this.penalty[2]!, this.penalty[3]!];
    const oldLambda = [this.lambda[0]!, this.lambda[1]!, this.lambda[2]!, this.lambda[3]!];
    const oldStick = [oldContacts[0]!.stick, oldContacts[1]!.stick];

    // Re-collide. Returning `true` with zero contacts keeps the
    // manifold registered so warm-start survives a brief separation;
    // the rows are zeroed in `computeConstraint`, so it contributes
    // nothing while inactive.
    readPose(this.solver, this.bodyA.cellId, this._poseA);
    readPose(this.solver, this.bodyB.cellId, this._poseB);
    const numNew = collideBoxes(SCRATCH_CONTACTS, this._poseA, this.bodyA, this._poseB, this.bodyB);
    this.numContacts = numNew;
    if (numNew === 0) {
      for (let r = 0; r < 4; r++) {
        this.lambda[r]! = 0;
        this.penalty[r]! = 0;
      }
      return true;
    }

    // Copy fresh contacts and merge old penalty/lambda by feature ID.
    for (let i = 0; i < numNew; i++) {
      const src = SCRATCH_CONTACTS[i]!;
      const dst = this.contacts[i]!;
      dst.rAx = src.rAx;
      dst.rAy = src.rAy;
      dst.rBx = src.rBx;
      dst.rBy = src.rBy;
      dst.nx = src.nx;
      dst.ny = src.ny;
      dst.fp = src.fp;
      dst.stick = false;
      this.penalty[i * 2 + 0]! = 0;
      this.penalty[i * 2 + 1]! = 0;
      this.lambda[i * 2 + 0]! = 0;
      this.lambda[i * 2 + 1]! = 0;
      for (let j = 0; j < oldNumContacts; j++) {
        if (oldContacts[j]!.fp === src.fp) {
          this.penalty[i * 2 + 0]! = oldPenalty[j * 2 + 0]!;
          this.penalty[i * 2 + 1]! = oldPenalty[j * 2 + 1]!;
          this.lambda[i * 2 + 0]! = oldLambda[j * 2 + 0]!;
          this.lambda[i * 2 + 1]! = oldLambda[j * 2 + 1]!;
          dst.stick = oldStick[j]!;
          if (oldStick[j]!) {
            // Static friction: keep the old anchor point.
            dst.rAx = oldContacts[j]!.rAx;
            dst.rAy = oldContacts[j]!.rAy;
            dst.rBx = oldContacts[j]!.rBx;
            dst.rBy = oldContacts[j]!.rBy;
          }
          break;
        }
      }
    }

    // Precompute Jacobians and C0 for each contact row. Reuse the
    // scratch poses we read just above.
    const poseA = this._poseA;
    const poseB = this._poseB;
    const cA = Math.cos(poseA.theta);
    const sA = Math.sin(poseA.theta);
    const cB = Math.cos(poseB.theta);
    const sB = Math.sin(poseB.theta);

    for (let i = 0; i < numNew; i++) {
      const con = this.contacts[i]!;
      const tx = con.ny;
      const ty = -con.nx;
      // World-frame anchor offsets.
      const rAWx = cA * con.rAx - sA * con.rAy;
      const rAWy = sA * con.rAx + cA * con.rAy;
      const rBWx = cB * con.rBx - sB * con.rBy;
      const rBWy = sB * con.rBx + cB * con.rBy;

      // Normal row: penetration constraint.
      this.JAn[i * 3 + 0]! = con.nx;
      this.JAn[i * 3 + 1]! = con.ny;
      this.JAn[i * 3 + 2]! = rAWx * con.ny - rAWy * con.nx; // cross(rAW, n)
      this.JBn[i * 3 + 0]! = -con.nx;
      this.JBn[i * 3 + 1]! = -con.ny;
      this.JBn[i * 3 + 2]! = -(rBWx * con.ny - rBWy * con.nx);

      // Tangent row: friction.
      this.JAt[i * 3 + 0]! = tx;
      this.JAt[i * 3 + 1]! = ty;
      this.JAt[i * 3 + 2]! = rAWx * ty - rAWy * tx;
      this.JBt[i * 3 + 0]! = -tx;
      this.JBt[i * 3 + 1]! = -ty;
      this.JBt[i * 3 + 2]! = -(rBWx * ty - rBWy * tx);

      // C0 = (basis · ((posA + rAW) − (posB + rBW))) + margin (normal only).
      const dpx = poseA.x + rAWx - poseB.x - rBWx;
      const dpy = poseA.y + rAWy - poseB.y - rBWy;
      this.C0n[i]! = con.nx * dpx + con.ny * dpy + COLLISION_MARGIN;
      this.C0t[i]! = tx * dpx + ty * dpy;
    }
    return true;
  }

  computeConstraint(alpha: number): void {
    // Truncated Taylor: C(x) ≈ C0(1 − α) + J · Δp.
    const offA = this.solver.offsets[this.bodyA.cellId]!;
    const offB = this.solver.offsets[this.bodyB.cellId]!;
    const initials = this.solver.initials;
    const positions = this.solver.positions;
    const dApx = positions[offA]! - initials[offA]!;
    const dApy = positions[offA + 1]! - initials[offA + 1]!;
    const dApt = positions[offA + 2]! - initials[offA + 2]!;
    const dBpx = positions[offB]! - initials[offB]!;
    const dBpy = positions[offB + 1]! - initials[offB + 1]!;
    const dBpt = positions[offB + 2]! - initials[offB + 2]!;

    for (let i = 0; i < this.numContacts; i++) {
      const dn =
        this.JAn[i * 3 + 0]! * dApx +
        this.JAn[i * 3 + 1]! * dApy +
        this.JAn[i * 3 + 2]! * dApt +
        this.JBn[i * 3 + 0]! * dBpx +
        this.JBn[i * 3 + 1]! * dBpy +
        this.JBn[i * 3 + 2]! * dBpt;
      const dt =
        this.JAt[i * 3 + 0]! * dApx +
        this.JAt[i * 3 + 1]! * dApy +
        this.JAt[i * 3 + 2]! * dApt +
        this.JBt[i * 3 + 0]! * dBpx +
        this.JBt[i * 3 + 1]! * dBpy +
        this.JBt[i * 3 + 2]! * dBpt;

      this.C[i * 2 + 0]! = this.C0n[i]! * (1 - alpha) + dn;
      this.C[i * 2 + 1]! = this.C0t[i]! * (1 - alpha) + dt;

      // Update friction cone from current normal lambda.
      const bound = Math.abs(this.lambda[i * 2 + 0]!) * this.friction;
      this.lambdaMax[i * 2 + 1]! = bound;
      this.lambdaMin[i * 2 + 1]! = -bound;

      // Sticking detection for static friction next frame.
      const con = this.contacts[i]!;
      con.stick =
        Math.abs(this.lambda[i * 2 + 1]!) < bound && Math.abs(this.C0t[i]!) < STICK_THRESH;
    }

    // Zero out unused rows so they contribute nothing to the dual update.
    for (let i = this.numContacts; i < 2; i++) {
      this.C[i * 2 + 0]! = 0;
      this.C[i * 2 + 1]! = 0;
    }
  }

  computeDerivatives(cellIdx: number): void {
    // Just copy the precomputed Jacobians (already in 3-component form).
    const J = this.J[cellIdx]!;
    if (cellIdx === 0) {
      for (let i = 0; i < this.numContacts; i++) {
        J[i * 2 * 3 + 0]! = this.JAn[i * 3 + 0]!;
        J[i * 2 * 3 + 1]! = this.JAn[i * 3 + 1]!;
        J[i * 2 * 3 + 2]! = this.JAn[i * 3 + 2]!;
        J[i * 2 * 3 + 3]! = this.JAt[i * 3 + 0]!;
        J[i * 2 * 3 + 4]! = this.JAt[i * 3 + 1]!;
        J[i * 2 * 3 + 5]! = this.JAt[i * 3 + 2]!;
      }
    } else {
      for (let i = 0; i < this.numContacts; i++) {
        J[i * 2 * 3 + 0]! = this.JBn[i * 3 + 0]!;
        J[i * 2 * 3 + 1]! = this.JBn[i * 3 + 1]!;
        J[i * 2 * 3 + 2]! = this.JBn[i * 3 + 2]!;
        J[i * 2 * 3 + 3]! = this.JBt[i * 3 + 0]!;
        J[i * 2 * 3 + 4]! = this.JBt[i * 3 + 1]!;
        J[i * 2 * 3 + 5]! = this.JBt[i * 3 + 2]!;
      }
    }
    // Clear unused rows.
    for (let i = this.numContacts; i < 2; i++) {
      for (let k = 0; k < 6; k++) J[i * 2 * 3 + k]! = 0;
    }
  }
}

// ─── Joint (revolute joint between two rigid bodies) ────────────────

export interface JointStiffness {
  /** Stiffness for the X position row. `Infinity` = hard. Default `Infinity`. */
  x?: number;
  /** Stiffness for the Y position row. `Infinity` = hard. Default `Infinity`. */
  y?: number;
  /** Stiffness for the angle row. `0` = free (revolute joint, the
   *  rope/chain default). `Infinity` = rigid weld. Default `0`. */
  angle?: number;
}

/** Internal term for a revolute joint (anchors `rA` on `bodyA`, `rB`
 *  on `bodyB`). Default: hard position rows, free angle (hinge);
 *  override via `JointStiffness`. Port of the AVBD 2D `Joint`. User
 *  code uses the `Joint` Relation via `world.add(joint(...))`. */
export class JointTerm extends Term {
  readonly bodyA: Body;
  readonly bodyB: Body;
  rAx: number;
  rAy: number;
  rBx: number;
  rBy: number;
  readonly torqueArm: number;
  readonly restAngle: number;
  // Cached anchor-rotation values per body (refreshed each iter).
  private _Cn = new Float64Array(3);
  private _C0Cache = new Float64Array(3);
  private _poseA: PoseScratch = { x: 0, y: 0, theta: 0 };
  private _poseB: PoseScratch = { x: 0, y: 0, theta: 0 };

  constructor(
    solver: Solver,
    bodyA: Body,
    bodyB: Body,
    rA: { x: number; y: number },
    rB: { x: number; y: number },
    opts: JointStiffness = {},
  ) {
    super(solver, [bodyA.cellId, bodyB.cellId], 3);
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.rAx = rA.x;
    this.rAy = rA.y;
    this.rBx = rB.x;
    this.rBy = rB.y;
    this.stiffness[0]! = opts.x ?? Number.POSITIVE_INFINITY;
    this.stiffness[1]! = opts.y ?? Number.POSITIVE_INFINITY;
    this.stiffness[2]! = opts.angle ?? 0;
    this.restAngle = bodyA.pose.peek().theta - bodyB.pose.peek().theta;
    const sumW = bodyA.w + bodyB.w;
    const sumH = bodyA.h + bodyB.h;
    // AVBD's torqueArm scales the angular row so its units are
    // commensurate with the positional rows.
    this.torqueArm = sumW * sumW + sumH * sumH;
  }

  initialize(): boolean {
    readPose(this.solver, this.bodyA.cellId, this._poseA);
    readPose(this.solver, this.bodyB.cellId, this._poseB);
    const poseA = this._poseA;
    const poseB = this._poseB;
    const cA = Math.cos(poseA.theta);
    const sA = Math.sin(poseA.theta);
    const cB = Math.cos(poseB.theta);
    const sB = Math.sin(poseB.theta);
    const aWx = poseA.x + cA * this.rAx - sA * this.rAy;
    const aWy = poseA.y + sA * this.rAx + cA * this.rAy;
    const bWx = poseB.x + cB * this.rBx - sB * this.rBy;
    const bWy = poseB.y + sB * this.rBx + cB * this.rBy;
    this._C0Cache[0]! = aWx - bWx;
    this._C0Cache[1]! = aWy - bWy;
    this._C0Cache[2]! = (poseA.theta - poseB.theta - this.restAngle) * this.torqueArm;
    return this.stiffness[0]! !== 0 || this.stiffness[1]! !== 0 || this.stiffness[2]! !== 0;
  }

  computeConstraint(alpha: number): void {
    readPose(this.solver, this.bodyA.cellId, this._poseA);
    readPose(this.solver, this.bodyB.cellId, this._poseB);
    const poseA = this._poseA;
    const poseB = this._poseB;
    const cA = Math.cos(poseA.theta);
    const sA = Math.sin(poseA.theta);
    const cB = Math.cos(poseB.theta);
    const sB = Math.sin(poseB.theta);
    const aWx = poseA.x + cA * this.rAx - sA * this.rAy;
    const aWy = poseA.y + sA * this.rAx + cA * this.rAy;
    const bWx = poseB.x + cB * this.rBx - sB * this.rBy;
    const bWy = poseB.y + sB * this.rBx + cB * this.rBy;
    this._Cn[0]! = aWx - bWx;
    this._Cn[1]! = aWy - bWy;
    this._Cn[2]! = (poseA.theta - poseB.theta - this.restAngle) * this.torqueArm;
    for (let i = 0; i < 3; i++) {
      if (this.stiffness[i]! === Number.POSITIVE_INFINITY) {
        this.C[i]! = this._Cn[i]! - this.C0[i]! * alpha;
      } else {
        this.C[i]! = this._Cn[i]!;
      }
    }
  }

  computeDerivatives(cellIdx: number): void {
    const J = this.J[cellIdx]!;
    const Hcols = this.HCols[cellIdx]!;
    const pose = cellIdx === 0 ? this._poseA : this._poseB;
    const c = Math.cos(pose.theta);
    const s = Math.sin(pose.theta);
    const rLocalX = cellIdx === 0 ? this.rAx : this.rBx;
    const rLocalY = cellIdx === 0 ? this.rAy : this.rBy;
    const rWx = c * rLocalX - s * rLocalY;
    const rWy = s * rLocalX + c * rLocalY;
    const sign = cellIdx === 0 ? 1 : -1;
    // Row 0: ∂C[0]/∂(x, y, θ)
    J[0]! = sign;
    J[1]! = 0;
    J[2]! = -sign * rWy;
    // Row 1: ∂C[1]/∂(x, y, θ)
    J[3]! = 0;
    J[4]! = sign;
    J[5]! = sign * rWx;
    // Row 2: angle row
    J[6]! = 0;
    J[7]! = 0;
    J[8]! = sign * this.torqueArm;
    // Hessian column norms — only non-zero entries are at H[r][2,2].
    Hcols[0]! = 0;
    Hcols[1]! = 0;
    Hcols[2]! = Math.abs(rWx);
    Hcols[3]! = 0;
    Hcols[4]! = 0;
    Hcols[5]! = Math.abs(rWy);
    Hcols[6]! = 0;
    Hcols[7]! = 0;
    Hcols[8]! = 0;
  }
}

/** @internal — soft 2-row term pulling a body's translation toward
 *  `target` with finite `stiffness` (angle DOF left free). Backs the
 *  `BodyAnchor` relation; see `bodyAnchor`. */
export class BodyAnchorTerm extends Term {
  readonly body: Body;
  /** World-space target signal (mutable). */
  readonly target: Writable<Vec>;
  /** Mutable stiffness signal — refreshed each `initialize()`. */
  readonly stiffnessSig: Writable<Num>;

  constructor(solver: Solver, body: Body, target: Writable<Vec>, stiffness: Writable<Num>) {
    super(solver, [body.cellId], 2);
    this.body = body;
    this.target = target;
    this.stiffnessSig = stiffness;
  }

  initialize(): boolean {
    const k = this.stiffnessSig.value;
    this.stiffness[0]! = k;
    this.stiffness[1]! = k;
    return k > 0;
  }

  computeConstraint(_alpha: number): void {
    const off = this.cellOffsets[0]!;
    const p = this.solver.positions;
    const t = this.target.value;
    this.C[0]! = p[off]! - t.x;
    this.C[1]! = p[off + 1]! - t.y;
  }

  computeDerivatives(_cellIdx: number): void {
    const J = this.J[0]!;
    const Hcols = this.HCols[0]!;
    // ∂C[0]/∂(x, y, θ) = (1, 0, 0)
    J[0]! = 1;
    J[1]! = 0;
    J[2]! = 0;
    // ∂C[1]/∂(x, y, θ) = (0, 1, 0)
    J[3]! = 0;
    J[4]! = 1;
    J[5]! = 0;
    // No geometric stiffness (linear constraint).
    Hcols[0]! = 0;
    Hcols[1]! = 0;
    Hcols[2]! = 0;
    Hcols[3]! = 0;
    Hcols[4]! = 0;
    Hcols[5]! = 0;
  }
}

// ─── Joint / weld / bodyAnchor Relations ────────────────────────────

/** Revolute or weld joint between two bodies (add via `world.add`).
 *  Default: hard position rows, free angle (hinge). `{ angle: Infinity }`
 *  welds; finite `{ x, y }` softens. `world` skips broadphase contacts
 *  between jointed pairs. */
export class Joint implements Relation {
  constructor(
    readonly bodyA: Body,
    readonly bodyB: Body,
    readonly rA: { x: number; y: number },
    readonly rB: { x: number; y: number },
    readonly opts?: JointStiffness,
  ) {}

  bind(c: Constraints): () => void {
    if (this.bodyA.cellId < 0 || this.bodyB.cellId < 0) {
      throw new Error("joint: add both bodies before the joint");
    }
    const f = new JointTerm(c.solver, this.bodyA, this.bodyB, this.rA, this.rB, this.opts);
    c.solver.addTerm(f);
    return () => c.solver.removeTerm(f);
  }
}

export function joint(
  a: Body,
  b: Body,
  rA: { x: number; y: number },
  rB: { x: number; y: number },
  opts?: JointStiffness,
): Joint {
  return new Joint(a, b, rA, rB, opts);
}

/** Rigid weld — a joint with all rows hard; fuses two bodies while
 *  keeping their independent inertias. */
export function weld(
  a: Body,
  b: Body,
  rA: { x: number; y: number },
  rB: { x: number; y: number },
): Joint {
  return new Joint(a, b, rA, rB, {
    x: Number.POSITIVE_INFINITY,
    y: Number.POSITIVE_INFINITY,
    angle: Number.POSITIVE_INFINITY,
  });
}

/** Soft "drag" handle: pulls a body's translation toward `target`
 *  with finite stiffness. The body keeps its mass and reacts to
 *  contacts, so it lags behind the cursor when blocked rather than
 *  punching through. `target` and `stiffness` are mutable signals.
 *
 *    const a = bodyAnchor(body, body.position.value, 5e4);
 *    world.addWhile(dragging, a);
 *    onPointerMove(p => a.target.value = p);
 */
export class BodyAnchor implements Relation {
  readonly target: Writable<Vec>;
  readonly stiffness: Writable<Num>;

  constructor(
    readonly body: Body,
    target: Writable<Vec> | { x: number; y: number },
    stiffness: Writable<Num> | number,
  ) {
    this.target = isSignal(target)
      ? (target as Writable<Vec>)
      : (vec(target.x, target.y) as Writable<Vec>);
    this.stiffness = isSignal(stiffness)
      ? (stiffness as Writable<Num>)
      : (numSig(stiffness) as Writable<Num>);
  }

  bind(c: Constraints): () => void {
    if (this.body.cellId < 0) throw new Error("bodyAnchor: add the body first");
    const f = new BodyAnchorTerm(c.solver, this.body, this.target, this.stiffness);
    c.solver.addTerm(f);
    return () => c.solver.removeTerm(f);
  }
}

export function bodyAnchor(
  body: Body,
  target: Writable<Vec> | { x: number; y: number },
  stiffness: Writable<Num> | number = 1e5,
): BodyAnchor {
  return new BodyAnchor(body, target, stiffness);
}
