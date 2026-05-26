// =====================================================================
// typed-factor.ts — heterogeneous-output factor lens.
//
// Generalises `factorLens` (scalar-in, scalar-out) to typed
// inputs and outputs via the `Pack` trait:
//
//   const { centroid, rotation, scale } = factor(
//     [v1, v2, v3] as const,                 // Writable<Vec>[]
//     {                                      // record of named outputs
//       centroid: { Cls: Vec, fwd: pts => …, fields: ["x", "y"] },
//       rotation: { Cls: Num, fwd: pts => atan2(…) },
//       scale:    { Cls: Num, fwd: pts => hypot(…) },
//     },
//   );
//
//   centroid.value = { x: 100, y: 50 };   // Writable<Vec> — typed!
//   rotation.value = Math.PI / 4;
//   scale.value = 50;
//
// Engine work:
//   - Inputs and outputs are FLAT-packed via Pack traits.
//   - Jacobian is the full M_flat × N_flat matrix.
//   - Writing one channel sends a sparse δy (zero except in that
//     channel's slice) through the LSQ pseudoinverse.
//   - Cross-channel invariance is approximate (the Jacobian path);
//     for closed-form, use specialised lenses like `procrustesLens`.
//
// 1→M case ("bundle"): just `factor()` applied to a single typed
// input. Helper `bundle()` is provided for ergonomic single-source
// authoring.
// =====================================================================

import {
  batch,
  Num,
  type Of,
  type Pack,
  type Read,
  type Signal,
  type Traits,
  Vec,
  type Writable,
} from "../index";

// ─── Types ─────────────────────────────────────────────────────────────

/** Input cell: writable signal whose value class declares the `pack`
 *  trait. Vec, Num, Pose, Box, Color, Range all satisfy this. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export type PackedInput<T = any> = Writable<Read<T> & Traits<T, "pack">>;

/** Output specification: a target class + a fwd from typed inputs to
 *  the value the class wraps. Optional analytical Jacobian skips FD. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export interface OutputSpec<C extends new (...args: never[]) => Signal<any>> {
  Cls: C;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on input values
  fwd: (inputs: ReadonlyArray<any>) => Of<InstanceType<C>>;
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

  // ALL-or-nothing analytical Jacobian: skip FD entirely when every
  // output supplies one. (Mixed mode is possible but complicates code
  // for marginal benefit on the prototype.)
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

    // Working copies for FD: typedScratch[k] gets re-unpacked when its
    // slice of flatIn is perturbed. Initial value = current.
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
      // Pack target into a scratch slot of flatOutPerturbed, just
      // reusing existing buffer space so no allocation.
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
    const cell = Cls.lens(
      inputs as never,
      (vals: ReadonlyArray<unknown>) => spec.fwd(vals as never),
      (target: unknown, vals: ReadonlyArray<unknown>) => computeBwd(idx, target, vals),
    ) as Writable<Signal<unknown>> & { setter?: (v: unknown) => void };

    // ── Auto-converge wrapper ────────────────────────────────────────
    // Wrap the single-Newton-step setter with an iter loop until the
    // channel's reading is within tol of target. Linear-fwd cases
    // converge in 1 iter (overhead is one re-peek + distance check);
    // non-linear cases converge in 3-25 depending on geometry.
    if (converge) {
      const originalSetter = cell.setter!;
      const outPack = outputPacks[idx]!;
      const outDim = outputDims[idx]!;
      const targetBuf = new Float64Array(outDim);
      const currentBuf = new Float64Array(outDim);
      cell.setter = (target: unknown) => {
        batch(() => {
          // Pack target once
          outPack.read(target as never, targetBuf as unknown as Float64Array, 0);
          for (let it = 0; it < maxIters; it++) {
            originalSetter(target);
            // Re-read current value via the cell's getter
            const cur = (cell as { peek(): unknown }).peek();
            outPack.read(cur as never, currentBuf as unknown as Float64Array, 0);
            let sumSq = 0;
            for (let d = 0; d < outDim; d++) {
              const diff = targetBuf[d]! - currentBuf[d]!;
              sumSq += diff * diff;
            }
            if (Math.sqrt(sumSq) < tol) break;
          }
        });
      };
    }

    result[key] = cell;
  }
  return result as FactorResult<O>;
}

// ─── factorTuple: positional API ───────────────────────────────────────
//
// Same engine, no names. Outputs are a tuple of specs; the result is a
// tuple of writables typed via mapped-tuple inference.
//
//   const [centroid, rotation, scale] = factorTuple(
//     [v1, v2, v3] as const,
//     [
//       { Cls: Vec, fwd: pts => ({...}) },
//       { Cls: Num, fwd: pts => Math.atan2(...) },
//       { Cls: Num, fwd: pts => Math.hypot(...) },
//     ],
//   );
//
// Trade-off vs named: terser at call sites, destructure feels right
// for the "factor into N aspects" framing, but loses self-documenting
// names. Order-sensitive (refactors must re-align destructure).
// =====================================================================

export function factorTuple<
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  T extends readonly OutputSpec<any>[],
>(
  inputs: readonly PackedInput[],
  outputs: readonly [...T],
  opts: FactorOpts = {},
): { [K in keyof T]: Writable<InstanceType<T[K]["Cls"]>> } {
  // Wrap to named, call factor, unwrap. The named-record construction
  // is a one-time setup cost; the per-write hot path is identical.
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  const named: Record<string, OutputSpec<any>> = {};
  for (let i = 0; i < outputs.length; i++) named[String(i)] = outputs[i]!;
  const result = factor(inputs, named, opts);
  return outputs.map((_, i) => (result as Record<string, unknown>)[String(i)]) as never;
}

// ─── bundle: 1→M dual, sugar over factor() with one input ──────────────
//
// A single typed source factored into M coupled views. The same engine
// machinery as factor(); the only restriction is that the input array
// has length 1, so there's a single source that all views derive from.
//
// Coupling: writing view K sends a sparse δy through the Jacobian solve.
// Since N is small (the source's pack dim), the Jacobian is small and
// the LSQ tries to land on target_K with minimal perturbation to other
// channels' projections.
// =====================================================================

export function bundle<
  T,
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  O extends Record<string, OutputSpec<any>>,
>(source: Writable<Read<T> & Traits<T, "pack">>, views: O, opts: FactorOpts = {}): FactorResult<O> {
  // Adapt: factor() takes an array of inputs; pass [source]. The view
  // fwds receive an array `[currentSource]`, so wrap each view's
  // single-arg fwd into the array form.
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

// ─── Bundle convenience: bundle a value-class-typed source as field-like
//     bundle where each view is just a field of the source.
//     This is the dual of "independent N→1 ×M" but on a single source —
//     equivalent to a stack of `field()` calls, except the writes go
//     through the joint Jacobian solve (so cross-channel coupling is
//     present when source's structure couples them).
// =====================================================================

// (no extra API needed — `field()` already does the simple case;
//  use `bundle()` when you want the coupled-write behaviour.)

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
// Just for showcase / comparison: factor() can express Procrustes
// with typed outputs (centroid is a real Vec, not two Nums) but the
// bwd is still Jacobian-LSQ. The closed-form `procrustesLens` from
// `./factor-lens.ts` is faster and exact; this version exists so the
// typed-output ergonomics can be eyeballed.
// =====================================================================

export function procrustesTyped(points: readonly PackedInput<Of<Vec>>[]): {
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
        fwd: (pts: readonly Of<Vec>[]) => {
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
        fwd: (pts: readonly Of<Vec>[]) => {
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
        fwd: (pts: readonly Of<Vec>[]) => {
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
