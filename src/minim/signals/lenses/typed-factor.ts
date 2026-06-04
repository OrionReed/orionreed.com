// =====================================================================
// typed-factor.ts — heterogeneous-output factor lens.
//
// Generalises `factorLens` (scalar-only) to typed inputs/outputs via the
// `Pack` trait. Inputs and outputs are flat-packed; the Jacobian is the
// full M×N matrix; writing one channel sends a sparse δy through the LSQ
// pseudoinverse. Invariance is approximate (the Jacobian path) — use
// closed-form lenses like `procrustesLens` for exactness.
//
//   const { centroid, rotation, scale } = factor([v1, v2, v3] as const, {
//     centroid: { Cls: Vec, fwd: pts => … },
//     rotation: { Cls: Num, fwd: pts => atan2(…) },
//     scale:    { Cls: Num, fwd: pts => hypot(…) },
//   });
//   centroid.value = { x: 100, y: 50 };  // typed
//
// `bundle()` is the 1→M case: `factor()` over a single typed source.
// =====================================================================

import {
  type Cell,
  type Inner,
  Num,
  type Pack,
  type Read,
  type Traits,
  Vec,
  type Writable,
} from "../index";

// ─── Types ─────────────────────────────────────────────────────────────

/** Input cell: writable cell whose value class declares the `pack`
 *  trait. Vec, Num, Pose, Box, Color, Range all satisfy this. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export type PackedInput<T = any> = Writable<Read<T> & Traits<T, "pack">>;

/** Output specification: a target class + a fwd from typed inputs to
 *  the value the class wraps. Optional analytical Jacobian skips FD. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export interface OutputSpec<C extends new (...args: never[]) => Cell<any>> {
  Cls: C;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on input values
  fwd: (inputs: ReadonlyArray<any>) => Inner<InstanceType<C>>;
  /** Optional analytical Jacobian. Returns dim(Cls) rows, each of
   *  length `sum(input pack dims)`. If supplied for ALL outputs, FD
   *  is skipped entirely → faster AND exact (no eps drift). */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  jacobian?: (inputs: ReadonlyArray<any>) => readonly (readonly number[])[];
}

/** Result type: writable cell per output key, typed by the spec's Cls. */
export type FactorResult<
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  O extends Record<string, OutputSpec<any>>,
> = { [K in keyof O]: Writable<InstanceType<O[K]["Cls"]>> };

export interface FactorOpts {
  /** Per-input mobility weights. 0 = pinned. Defaults to 1 for all. */
  inputWeights?: readonly number[];
  /** Levenberg-Marquardt damping. Default 1e-6. */
  damping?: number;
  /** Finite-difference epsilon. Default 1e-5. */
  eps?: number;
  /** Auto-iterate the bwd until the written channel's reading is
   *  within `tol` of target (or `maxIters` exhausted). Cheap when
   *  forwards are linear (1 iter); needed for non-linear forwards
   *  to land exactly without user-side loops. Default `false`. */
  converge?: boolean;
  /** Max iters when `converge: true`. Default 10. */
  maxIters?: number;
  /** Convergence tolerance (per-channel L2). Default 1e-4. */
  tol?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function getPack<T>(cell: { constructor: unknown }): Pack<T> {
  const ctor = cell.constructor as { traits?: { pack?: Pack<T> } };
  const p = ctor.traits?.pack;
  if (!p) {
    const name = (ctor as { name?: string }).name ?? "?";
    throw new Error(`typed-factor: ${name} has no traits.pack`);
  }
  return p;
}

function getPackFromCls<T>(Cls: { traits?: { pack?: Pack<T> } }): Pack<T> {
  const p = Cls.traits?.pack;
  if (!p) {
    const name = (Cls as { name?: string }).name ?? "?";
    throw new Error(`typed-factor: ${name} has no traits.pack`);
  }
  return p;
}

function cumOffsets(dims: readonly number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const d of dims) {
    out.push(acc);
    acc += d;
  }
  return out;
}

// ─── factor: the typed N→M Jacobian-LSQ primitive ──────────────────────

export function factor<
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  O extends Record<string, OutputSpec<any>>,
>(inputs: readonly PackedInput[], outputs: O, opts: FactorOpts = {}): FactorResult<O> {
  const inputCount = inputs.length;
  if (inputCount === 0) {
    throw new Error("typed-factor: need ≥ 1 input");
  }

  const inputPacks = inputs.map(s => getPack(s as unknown as { constructor: unknown }));
  const inputDims = inputPacks.map(p => p.dim);
  const inputOffsets = cumOffsets(inputDims);
  const N = inputDims.reduce((s, d) => s + d, 0);

  // Map each flat input index back to its source input index — used
  // to know which typed input to re-unpack after FD perturbation.
  const whichInput = new Array<number>(N);
  for (let k = 0; k < inputCount; k++) {
    for (let d = 0; d < inputDims[k]!; d++) {
      whichInput[inputOffsets[k]! + d] = k;
    }
  }

  const outputKeys = Object.keys(outputs);
  const outputCount = outputKeys.length;
  if (outputCount === 0) {
    throw new Error("typed-factor: need ≥ 1 output");
  }

  const outputSpecs = outputKeys.map(k => outputs[k]!);
  const outputPacks = outputSpecs.map(s => getPackFromCls(s.Cls));
  const outputDims = outputPacks.map(p => p.dim);
  const outputOffsets = cumOffsets(outputDims);
  const M = outputDims.reduce((s, d) => s + d, 0);

  const weights = opts.inputWeights ?? (Array.from({ length: N }, () => 1) as readonly number[]);
  if (weights.length !== N) {
    throw new Error(`typed-factor: inputWeights length ${weights.length} ≠ flat input dim ${N}`);
  }
  const eps = opts.eps ?? 1e-5;
  const lambda = opts.damping ?? 1e-6;
  const converge = opts.converge ?? false;
  const maxIters = opts.maxIters ?? 10;
  const tol = opts.tol ?? 1e-4;

  // All-or-nothing analytical Jacobian: skip FD only when every output
  // supplies one (no mixed mode).
  const useAnalyticalJ = outputSpecs.every(s => s.jacobian !== undefined);

  // Shared scratch buffers — safe across the M cells because writes
  // execute synchronously inside one `_setWithExclusion` call.
  const flatIn = new Float64Array(N);
  const flatOutBase = new Float64Array(M);
  const flatOutPerturbed = new Float64Array(M);
  const J = new Float64Array(M * N);
  const A = new Float64Array(M * M);
  const Ainv = new Float64Array(M * M);
  const dy = new Float64Array(M);
  const kvec = new Float64Array(M);

  // ── per-write driver, shared by all M cells ──────────────────────────
  const computeBwd = (
    channelIdx: number, // which named output is being written
    target: unknown,
    vals: ReadonlyArray<unknown>,
  ): (unknown | undefined)[] => {
    // 1. Pack current inputs → flatIn
    for (let k = 0; k < inputCount; k++) {
      inputPacks[k]!.read(vals[k], flatIn as unknown as Float64Array, inputOffsets[k]!);
    }

    // FD working copies: typedScratch[k] is re-unpacked when its slice of
    // flatIn is perturbed.
    const typedScratch: unknown[] = vals.slice();

    // 2. Base outputs
    for (let j = 0; j < outputCount; j++) {
      const out = outputSpecs[j]!.fwd(typedScratch);
      outputPacks[j]!.read(out as never, flatOutBase as unknown as Float64Array, outputOffsets[j]!);
    }

    // 3. δy: sparse, only channelIdx's slice is non-zero.
    dy.fill(0);
    {
      const dim = outputDims[channelIdx]!;
      const baseOff = outputOffsets[channelIdx]!;
      // Pack target into flatOutPerturbed (reused buffer, no allocation).
      outputPacks[channelIdx]!.read(
        target as never,
        flatOutPerturbed as unknown as Float64Array,
        baseOff,
      );
      for (let i = 0; i < dim; i++) {
        dy[baseOff + i] = flatOutPerturbed[baseOff + i]! - flatOutBase[baseOff + i]!;
      }
    }

    // 4. Build Jacobian. Either analytical (fast + exact) or FD.
    if (useAnalyticalJ) {
      for (let j = 0; j < outputCount; j++) {
        const rows = outputSpecs[j]!.jacobian!(typedScratch);
        const dim = outputDims[j]!;
        const baseOff = outputOffsets[j]!;
        for (let d = 0; d < dim; d++) {
          const row = rows[d]!;
          for (let i = 0; i < N; i++) {
            J[(baseOff + d) * N + i] = row[i]!;
          }
        }
      }
    } else {
      for (let i = 0; i < N; i++) {
        const saved = flatIn[i]!;
        flatIn[i] = saved + eps;
        const k = whichInput[i]!;
        typedScratch[k] = inputPacks[k]!.write(flatIn as unknown as Float64Array, inputOffsets[k]!);
        for (let j = 0; j < outputCount; j++) {
          const o = outputSpecs[j]!.fwd(typedScratch);
          outputPacks[j]!.read(
            o as never,
            flatOutPerturbed as unknown as Float64Array,
            outputOffsets[j]!,
          );
          const dim = outputDims[j]!;
          const baseOff = outputOffsets[j]!;
          for (let d = 0; d < dim; d++) {
            J[(baseOff + d) * N + i] =
              (flatOutPerturbed[baseOff + d]! - flatOutBase[baseOff + d]!) / eps;
          }
        }
        flatIn[i] = saved;
        // Restore the affected typed input to its base value.
        typedScratch[k] = inputPacks[k]!.write(flatIn as unknown as Float64Array, inputOffsets[k]!);
      }
    }

    // 5. A = J W J^T + λI
    for (let r = 0; r < M; r++) {
      for (let c = 0; c < M; c++) {
        let s = 0;
        for (let i = 0; i < N; i++) {
          s += J[r * N + i]! * weights[i]! * J[c * N + i]!;
        }
        A[r * M + c] = s + (r === c ? lambda : 0);
      }
    }

    // 6. Solve A · k = δy
    if (!invertMatrix(A, M, Ainv)) {
      return vals.map(() => undefined);
    }
    for (let r = 0; r < M; r++) {
      let s = 0;
      for (let c = 0; c < M; c++) s += Ainv[r * M + c]! * dy[c]!;
      kvec[r] = s;
    }

    // 7. δx = W J^T k, applied to flatIn → produces new flat input vector.
    //    Then unpack per-input to typed updates.
    const updates = new Array<unknown | undefined>(inputCount);
    for (let k = 0; k < inputCount; k++) {
      const baseOff = inputOffsets[k]!;
      const dim = inputDims[k]!;
      let anyChange = false;
      for (let d = 0; d < dim; d++) {
        const flatIdx = baseOff + d;
        const w = weights[flatIdx]!;
        if (w === 0) continue;
        let dxi = 0;
        for (let r = 0; r < M; r++) dxi += J[r * N + flatIdx]! * kvec[r]!;
        const newVal = flatIn[flatIdx]! + w * dxi;
        if (newVal !== flatIn[flatIdx]) anyChange = true;
        flatIn[flatIdx] = newVal;
      }
      updates[k] = anyChange
        ? inputPacks[k]!.write(flatIn as unknown as Float64Array, baseOff)
        : undefined;
    }
    return updates;
  };

  // ── Build M output cells ─────────────────────────────────────────────
  const result = {} as Record<string, unknown>;
  for (let k = 0; k < outputCount; k++) {
    const idx = k;
    const key = outputKeys[idx]!;
    const spec = outputSpecs[idx]!;
    // biome-ignore lint/suspicious/noExplicitAny: typed at facade
    const Cls = spec.Cls as any;

    // Auto-converging backward: iterate the single-Newton step until the
    // channel's reading is within tol (1 iter when linear). Runs on a local
    // copy inside `put`, so the engine applies converged inputs in one shot.
    const outPack = outputPacks[idx]!;
    const outDim = outputDims[idx]!;
    const convergeBwd = (target: unknown, vals: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
      const targetBuf = new Float64Array(outDim);
      const currentBuf = new Float64Array(outDim);
      outPack.read(target as never, targetBuf as unknown as Float64Array, 0);
      const cur = vals.slice();
      for (let it = 0; it < maxIters; it++) {
        const updates = computeBwd(idx, target, cur);
        for (let i = 0; i < cur.length; i++) {
          if (updates[i] !== undefined) cur[i] = updates[i];
        }
        outPack.read(spec.fwd(cur as never) as never, currentBuf as unknown as Float64Array, 0);
        let sumSq = 0;
        for (let d = 0; d < outDim; d++) {
          const diff = targetBuf[d]! - currentBuf[d]!;
          sumSq += diff * diff;
        }
        if (Math.sqrt(sumSq) < tol) break;
      }
      return cur;
    };

    const cell = Cls.lens(
      inputs as never,
      (vals: ReadonlyArray<unknown>) => spec.fwd(vals as never),
      converge
        ? (target: unknown, vals: ReadonlyArray<unknown>) => convergeBwd(target, vals)
        : (target: unknown, vals: ReadonlyArray<unknown>) => computeBwd(idx, target, vals),
    ) as Writable<Cell<unknown>>;

    result[key] = cell;
  }
  return result as FactorResult<O>;
}

// ─── factorTuple: positional API ───────────────────────────────────────
//
// Same engine, no names. Outputs are a tuple of specs; the result is a
// tuple of writables. Terser to destructure, but order-sensitive and
// loses self-documenting names.
// =====================================================================

export function factorTuple<
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  T extends readonly OutputSpec<any>[],
>(
  inputs: readonly PackedInput[],
  outputs: readonly [...T],
  opts: FactorOpts = {},
): { [K in keyof T]: Writable<InstanceType<T[K]["Cls"]>> } {
  // Wrap to named, call factor, unwrap (one-time setup; hot path identical).
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  const named: Record<string, OutputSpec<any>> = {};
  for (let i = 0; i < outputs.length; i++) named[String(i)] = outputs[i]!;
  const result = factor(inputs, named, opts);
  return outputs.map((_, i) => (result as Record<string, unknown>)[String(i)]) as never;
}

// ─── bundle: 1→M dual, sugar over factor() with one input ──────────────
//
// A single typed source factored into M coupled views — `factor()` with
// a length-1 input array. Writing a view sends a sparse δy through the
// Jacobian solve (small, since N = the source's pack dim).
// =====================================================================

export function bundle<
  T,
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  O extends Record<string, OutputSpec<any>>,
>(source: Writable<Read<T> & Traits<T, "pack">>, views: O, opts: FactorOpts = {}): FactorResult<O> {
  // factor() takes an input array, so pass [source] and wrap each view's
  // fwd to receive the single-element array form.
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  const wrapped: Record<string, OutputSpec<any>> = {};
  for (const key of Object.keys(views)) {
    const v = views[key]!;
    wrapped[key] = {
      Cls: v.Cls,
      // biome-ignore lint/suspicious/noExplicitAny: variance escape
      fwd: (inputs: ReadonlyArray<any>) => v.fwd([inputs[0]!]),
      jacobian: v.jacobian
        ? // biome-ignore lint/suspicious/noExplicitAny: variance escape
          (inputs: ReadonlyArray<any>) => v.jacobian!([inputs[0]!])
        : undefined,
    };
  }
  return factor([source] as readonly PackedInput[], wrapped as O, opts);
}

// For field-style bundles, `field()` already covers the independent case;
// use `bundle()` when you want coupled writes through the Jacobian solve.

// ─── Matrix inverse (Gauss-Jordan with partial pivoting) ───────────────

function invertMatrix(A: Float64Array, M: number, out: Float64Array): boolean {
  const W = 2 * M;
  const aug = new Float64Array(M * W);
  for (let r = 0; r < M; r++) {
    for (let c = 0; c < M; c++) aug[r * W + c] = A[r * M + c]!;
    for (let c = 0; c < M; c++) aug[r * W + M + c] = r === c ? 1 : 0;
  }
  for (let i = 0; i < M; i++) {
    let p = i;
    let pv = Math.abs(aug[i * W + i]!);
    for (let r = i + 1; r < M; r++) {
      const v = Math.abs(aug[r * W + i]!);
      if (v > pv) {
        pv = v;
        p = r;
      }
    }
    if (pv < 1e-14) return false;
    if (p !== i) {
      for (let c = 0; c < W; c++) {
        const t = aug[i * W + c]!;
        aug[i * W + c] = aug[p * W + c]!;
        aug[p * W + c] = t;
      }
    }
    const inv = 1 / aug[i * W + i]!;
    for (let c = 0; c < W; c++) aug[i * W + c] *= inv;
    for (let r = 0; r < M; r++) {
      if (r === i) continue;
      const f = aug[r * W + i]!;
      if (f === 0) continue;
      for (let c = 0; c < W; c++) aug[r * W + c] -= f * aug[i * W + c]!;
    }
  }
  for (let r = 0; r < M; r++) {
    for (let c = 0; c < M; c++) out[r * M + c] = aug[r * W + M + c]!;
  }
  return true;
}

// ─── Sugar: closed-form Procrustes via factor() typed API ──────────────
//
// Procrustes with typed outputs (centroid is a real Vec) but a
// Jacobian-LSQ bwd — a showcase for the typed ergonomics. The
// closed-form `procrustesLens` is faster and exact.
// =====================================================================

export function procrustesTyped(points: readonly PackedInput<Inner<Vec>>[]): {
  centroid: Writable<Vec>;
  rotation: Writable<Num>;
  scale: Writable<Num>;
} {
  const K = points.length;
  return factor(
    points,
    {
      centroid: {
        Cls: Vec,
        fwd: (pts: readonly Inner<Vec>[]) => {
          let sx = 0;
          let sy = 0;
          for (let i = 0; i < K; i++) {
            sx += pts[i]!.x;
            sy += pts[i]!.y;
          }
          return { x: sx / K, y: sy / K };
        },
      },
      rotation: {
        Cls: Num,
        fwd: (pts: readonly Inner<Vec>[]) => {
          let sx = 0;
          let sy = 0;
          for (let i = 0; i < K; i++) {
            sx += pts[i]!.x;
            sy += pts[i]!.y;
          }
          return Math.atan2(pts[0]!.y - sy / K, pts[0]!.x - sx / K);
        },
      },
      scale: {
        Cls: Num,
        fwd: (pts: readonly Inner<Vec>[]) => {
          let sx = 0;
          let sy = 0;
          for (let i = 0; i < K; i++) {
            sx += pts[i]!.x;
            sy += pts[i]!.y;
          }
          return Math.hypot(pts[0]!.x - sx / K, pts[0]!.y - sy / K);
        },
      },
      // Damping bumped up — atan2/hypot are non-linear; without damping the
      // first-Newton-step error compounds at the boundary of well-conditioned.
    },
    { damping: 1e-3 },
  );
}
