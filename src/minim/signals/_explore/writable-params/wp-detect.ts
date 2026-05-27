// wp-detect.ts — diamond detection at construction time.
//
// A writable-param lens whose two writable parents share a transitive
// root primitive forms a "diamond" — two paths from the same source.
// The bwd's intentions for the two paths land on the same primitive;
// last-write-wins resolves the conflict. PutGet is violated whenever
// the intentions disagree.
//
// This module:
//   1. Records parents on each wp lens cell via `_wpParents` (debug field).
//   2. Walks the parent chain to compute the *transitive root set*.
//   3. Detects pairwise root-set overlaps among a lens's parents.
//
// The walker uses `_fusedOf.parent` (the engine's single-source chain
// pointer) plus our own `_wpParents` for multi-source nodes. Engine cells
// not touched by wp factories (primitives, classical lenses) have a
// well-defined root set: themselves (primitive) or their `_fusedOf.parent`
// chain bottom.

import { Num, type Read, Signal, Vec, type Writable } from "../../index";

// ─── Augment Signal with a wp-only parent tracker ──────────────────

const WP_PARENTS = Symbol("wpParents");
type WPMeta = { parents: readonly Signal<unknown>[] };

function tagParents(lens: Signal<unknown>, parents: readonly Signal<unknown>[]): void {
  (lens as unknown as Record<symbol, WPMeta>)[WP_PARENTS] = { parents };
}

function wpParents(s: Signal<unknown>): readonly Signal<unknown>[] | undefined {
  return (s as unknown as Record<symbol, WPMeta>)[WP_PARENTS]?.parents;
}

// ─── Transitive-root computation ────────────────────────────────────

/** Compute the set of root (writable-primitive) signals this cell can
 *  ultimately write to through any chain of single-source or multi-source
 *  bwd hops. Read-only cells (those with `getter` but no `setter`) bottom
 *  out as themselves but aren't writable — we still report them so the
 *  caller can decide.
 *
 *  A "root" here means: a Signal whose `setter` is undefined AND
 *  `getter` is undefined → a primitive root cell. Anything else is a
 *  pass-through. */
export function transitiveRoots(
  s: Read<unknown>,
  seen = new Set<Signal<unknown>>(),
): Set<Signal<unknown>> {
  const roots = new Set<Signal<unknown>>();
  walk(s as Signal<unknown>, seen, roots);
  return roots;
}

function walk(
  s: Signal<unknown>,
  seen: Set<Signal<unknown>>,
  roots: Set<Signal<unknown>>,
): void {
  if (seen.has(s)) return;
  seen.add(s);

  // wp-tagged: walk its declared parents.
  const wpps = wpParents(s);
  if (wpps !== undefined) {
    for (const p of wpps) walk(p, seen, roots);
    return;
  }

  // Engine single-source fused: walk its parent.
  const fused = (s as unknown as { _fusedOf?: { parent: Signal<unknown> } })._fusedOf;
  if (fused !== undefined) {
    walk(fused.parent, seen, roots);
    return;
  }

  // No upstream: this is a root (primitive or untagged opaque cell).
  roots.add(s);
}

// ─── Diamond report ─────────────────────────────────────────────────

export interface DiamondReport {
  hasDiamond: boolean;
  /** Pairs of (parentIdx, parentIdx, sharedRoot) for every overlap. */
  overlaps: Array<{ i: number; j: number; root: Signal<unknown> }>;
  /** Per-parent transitive root set (for inspection). */
  rootsPerParent: Array<Set<Signal<unknown>>>;
}

/** Analyse a list of parents for a writable lens. Returns a report
 *  flagging any root cell reachable from two or more parents. */
export function analyzeParents(parents: readonly Read<unknown>[]): DiamondReport {
  const rootsPerParent = parents.map(p => transitiveRoots(p));
  const overlaps: DiamondReport["overlaps"] = [];
  for (let i = 0; i < parents.length; i++) {
    for (let j = i + 1; j < parents.length; j++) {
      const ri = rootsPerParent[i]!;
      const rj = rootsPerParent[j]!;
      for (const r of ri) {
        if (rj.has(r)) overlaps.push({ i, j, root: r });
      }
    }
  }
  return { hasDiamond: overlaps.length > 0, overlaps, rootsPerParent };
}

// ─── Wrapping factories that record parents + (optionally) check ────

export type DiamondPolicy = "allow" | "warn" | "error";

export interface LensWOpts {
  /** What to do when a diamond is detected at construction.
   *  - `allow` (default): proceed, semantics may surprise.
   *  - `warn`: console.warn with overlap info.
   *  - `error`: throw at construction time. */
  diamonds?: DiamondPolicy;
}

/** Multi-parent writable lens that records its parents for static
 *  diamond detection. Identical runtime semantics to `Cls.lens([parents],
 *  fwd, bwd)`. The construction-time check is fast (one transitive walk
 *  per parent).
 *
 *  Cls defaults to `Num`. Pass `Vec`, `Bool`, `Pose`, etc. when the
 *  output type differs. */
export function lensTracked<
  P extends readonly Read<unknown>[],
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  C extends abstract new (...args: any[]) => Signal<any> = typeof Num,
>(
  parents: P,
  fwd: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) =>
    InstanceType<C> extends Signal<infer V> ? V : never,
  bwd: (
    target: InstanceType<C> extends Signal<infer V> ? V : never,
    vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
  ) => { [K in keyof P]?: P[K] extends Read<infer V> ? V : never },
  Cls: C = Num as unknown as C,
  opts: LensWOpts = {},
): Writable<InstanceType<C>> {
  const policy = opts.diamonds ?? "allow";
  if (policy !== "allow") {
    const sigParents = parents as unknown as readonly Signal<unknown>[];
    const report = analyzeParents(sigParents);
    if (report.hasDiamond) {
      const msg = describeDiamond(sigParents, report);
      if (policy === "warn") console.warn(`wp: diamond detected\n${msg}`);
      else throw new Error(`wp: diamond detected\n${msg}`);
    }
  }
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  const lens = (Cls as any).lens(parents, fwd, bwd) as Writable<InstanceType<C>>;
  tagParents(lens as unknown as Signal<unknown>, parents as unknown as readonly Signal<unknown>[]);
  return lens;
}

function describeDiamond(
  parents: readonly Signal<unknown>[],
  report: DiamondReport,
): string {
  const lines: string[] = [];
  for (const { i, j, root } of report.overlaps) {
    const pi = labelOf(parents[i]!);
    const pj = labelOf(parents[j]!);
    const rt = labelOf(root);
    lines.push(`  parents[${i}] (${pi}) and parents[${j}] (${pj}) both reach root ${rt}`);
  }
  lines.push("  intentions for the shared root will conflict; last-write-wins.");
  return lines.join("\n");
}

function labelOf(s: Signal<unknown>): string {
  const cls = s.constructor.name;
  const fused = (s as unknown as { _fusedOf?: unknown })._fusedOf !== undefined;
  return `${cls}${fused ? "(lens)" : "(primitive)"}`;
}

// ─── Re-exports of helper factories that auto-track ────────────────

export function vecRightTracked(
  a: Writable<Vec>,
  n: Writable<Num>,
  opts: LensWOpts = {},
): Writable<Vec> {
  return lensTracked(
    [a, n] as const,
    ([av, nv]) => ({ x: av.x + nv, y: av.y }),
    (target, [av, _nv]) => [{ x: av.x, y: target.y }, target.x - av.x] as const,
    Vec,
    opts,
  );
}
