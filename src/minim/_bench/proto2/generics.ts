// Generic capability-driven functions — `mean<T>`, `spring<T>`,
// `lerp<T>`, etc. Demonstrate that dispatching via `cell.type.X`
// is just as expressive as the current `[ALGEBRA]`/`[LERP]`/`[METRIC]`
// symbol slots, while being one less indirection and visible in JS
// dev tools without symbol unwrapping.
//
// The pattern in EVERY generic function:
//
//   1. Pull the type off the cell:  const t = cell.type;
//   2. Pull the capability off the type:  t.algebra, t.lerp, t.metric
//   3. Throw with a useful error if missing.
//   4. Use it as plain math (cells unwrapped to .peek() / () values).
//
// User-defined capabilities work the same way — just stamp them as
// extra properties on the Type. `Object.assign(Vec, { rotationSpace: impl })`.

import { computed, effect, type SignalFn } from "./alien-trim";
import { startBatch, endBatch } from "./alien-trim";
import type { Cell, RO, Type, Algebra } from "./v2";

// ── Helpers ─────────────────────────────────────────────────────────

function typeOf<T>(cell: Cell<T> | RO<T>): Type<T> {
  const t = (cell as any).type as Type<T> | undefined;
  if (!t) throw new Error(
    "generic op called on a typeless cell. " +
    "use a typed cell (e.g. `Vec({x,y})`, `Num(0)`) instead of bare `cell(0)`.",
  );
  return t;
}

function algebraOf<T>(cell: Cell<T> | RO<T>): Algebra<T> {
  const t = typeOf(cell);
  if (!t.algebra) {
    throw new Error(
      `type \`${(t as any).name ?? "<unnamed>"}\` has no algebra. ` +
      "ops like mean/spring/drift require add/sub/scale.",
    );
  }
  return t.algebra;
}

function lerpOf<T>(cell: Cell<T> | RO<T>): (a: T, b: T, t: number) => T {
  const t = typeOf(cell);
  if (!t.lerp) throw new Error(`type \`${(t as any).name ?? "<unnamed>"}\` has no lerp`);
  return t.lerp;
}

function metricOf<T>(cell: Cell<T> | RO<T>): (a: T, b: T) => number {
  const t = typeOf(cell);
  if (!t.metric) throw new Error(`type \`${(t as any).name ?? "<unnamed>"}\` has no metric`);
  return t.metric;
}

// ── mean — read avg, write distributes (generic over any T with algebra) ─

/** Reactive arithmetic mean of N cells. Reading returns the average;
 *  writing distributes the delta evenly across inputs.
 *
 *  Works on ANY type with an `algebra` capability — Num, Vec, Color,
 *  Transform, your custom struct, ... */
export function mean<T>(...cells: Cell<T>[]): Cell<T> {
  if (cells.length === 0) throw new Error("mean: need at least one cell");
  const alg = algebraOf(cells[0]);
  const n = cells.length;
  const invN = 1 / n;

  // Read: average of all values (subscribes to each via call).
  const avg = computed(() => {
    let acc = cells[0]();
    for (let i = 1; i < n; i++) acc = alg.add(acc, cells[i]());
    return alg.scale(acc, invN);
  });

  // Wrap as a callable that delegates read to `avg` and write to
  // distribution.
  const fn: any = function (...args: any[]) {
    if (args.length === 0) return avg();
    const target = args[0];
    // Current mean (untracked).
    let curAvg = cells[0].peek();
    for (let i = 1; i < n; i++) curAvg = alg.add(curAvg, cells[i].peek());
    curAvg = alg.scale(curAvg, invN);
    const delta = alg.sub(target, curAvg);
    startBatch();
    try { for (let i = 0; i < n; i++) cells[i](alg.add(cells[i].peek(), delta)); }
    finally { endBatch(); }
  };
  return fn as Cell<T>;
}

// ── lerp — plain reactive lerp between two cells ────────────────────

export function lerp<T>(a: Cell<T> | RO<T>, b: Cell<T> | RO<T>, t: number | (() => number)): RO<T> {
  const fn = lerpOf(a);
  const tg = typeof t === "function" ? t : () => t;
  return computed(() => fn(a(), b(), tg())) as unknown as RO<T>;
}

// ── distance — plain reactive metric between two cells ──────────────

export function distance<T>(a: Cell<T> | RO<T>, b: Cell<T> | RO<T>): RO<number> {
  const fn = metricOf(a);
  return computed(() => fn(a(), b())) as unknown as RO<number>;
}

// ── spring — physics integrator. Returns disposer. ──────────────────
//
// Sketch only — drives `sig` toward `target` using the type's algebra
// and the type's metric for precision-stop. The real impl would tie
// into Anim's drive loop; here it shows that the capability dispatch
// works generically.

export interface SpringOpts {
  stiffness?: number;
  damping?: number;
  /** Stop when |sig - target| < precision. Requires the type's metric. */
  precision?: number;
}

export function springStep<T>(
  sig: Cell<T>,
  target: () => T,
  velRef: { current: T },
  dt: number,
  opts: SpringOpts = {},
): boolean {
  const k = opts.stiffness ?? 100;
  const c = opts.damping ?? 10;
  const t = typeOf(sig);
  const alg = algebraOf(sig);
  const m = t.metric;
  // F = -k(x - target) - c*v
  const cur = sig.peek();
  const tg = target();
  const displacement = alg.sub(cur, tg);
  const restoring = alg.scale(displacement, -k);
  const damping = alg.scale(velRef.current, -c);
  const force = alg.add(restoring, damping);
  velRef.current = alg.add(velRef.current, alg.scale(force, dt));
  const nextPos = alg.add(cur, alg.scale(velRef.current, dt));
  sig(nextPos);
  // Stop when within precision of target (requires metric).
  if (opts.precision !== undefined && m !== undefined) {
    return m(nextPos, tg) <= opts.precision;
  }
  return false;
}

// ── Capability extension demo — user-defined capability ─────────────
//
// Show that user code can add capabilities by just stamping them on
// the Type. No `registerCapability` API needed.

/** Demo capability: serialise to string. */
export interface Serialise<T> {
  (v: T): string;
}

export function serialise<T>(cell: Cell<T> | RO<T>): RO<string> {
  const t = typeOf(cell);
  const s = (t as any).serialise as Serialise<T> | undefined;
  if (!s) throw new Error(`type \`${(t as any).name ?? "?"}\` has no serialise capability`);
  return computed(() => s(cell())) as unknown as RO<string>;
}

void effect;  // re-export marker
