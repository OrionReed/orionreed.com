// Generic capability-driven functions — `mean<T>`, `spring<T>`,
// `lerp<T>`, etc. Dispatch via `cell.type.X` direct property access.
// No symbol slots, no registration step.
//
// Pattern in every generic function:
//
//   1. Pull the type off the cell:  const t = cell.type;
//   2. Pull the capability:          t.linear, t.lerp, t.metric
//   3. Throw with a useful error if missing.
//   4. Use as plain math (cells unwrapped to .peek() / () values).
//
// User-defined capabilities work the same way — stamp them on the
// Type. `Object.assign(Vec, { rotationSpace: impl })`.
//
// Many of these generics are redundant for users with concrete cell
// types — `cell.add(b)`, `cell.lerp(b, t)`, `cell.distance(b)` are
// directly typed via composite-capability inference. The generics
// exist for code polymorphic in T:
//   `function center<T>(cells: Cell<T>[]) { return mean(...cells); }`
//
// Generator-based behaviors (`spring`, `oscillate`, `attract`, `drift`)
// live in `./behaviors`. They wrap `springStep` (below) with `drive`.

import { computed, effect } from "./engine";
import { startBatch, endBatch } from "./engine";
import type { Cell, RO, Type, Linear } from "./cell";
import type { SpringOpts } from "./behaviors";

// ── Helpers ─────────────────────────────────────────────────────────

// `Cell<T, any>` — generic ops accept any cell flavor of T. The
// per-call-site C the cell carries is invisible to the generic.
type AnyCell<T> = Cell<T, any> | RO<T, any>;

function typeOf<T>(cell: AnyCell<T>): Type<T, any> {
  const t = (cell as any).type as Type<T, any> | undefined;
  if (!t) throw new Error(
    "generic op called on a typeless cell. " +
    "use a typed cell (e.g. `Vec({x,y})`, `Num(0)`) instead of bare `cell(0)`.",
  );
  return t;
}

function linearOf<T>(cell: AnyCell<T>): Linear<T> {
  const t = typeOf(cell);
  if (!t.linear) {
    throw new Error(
      `type \`${(t as any).name ?? "<unnamed>"}\` has no linear capability. ` +
      "ops like mean/spring/drift require add/sub/scale.",
    );
  }
  return t.linear;
}

function lerpOf<T>(cell: AnyCell<T>): (a: T, b: T, t: number) => T {
  const t = typeOf(cell);
  if (!t.lerp) throw new Error(`type \`${(t as any).name ?? "<unnamed>"}\` has no lerp`);
  return t.lerp;
}

function metricOf<T>(cell: AnyCell<T>): (a: T, b: T) => number {
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
export function mean<T>(...cells: Cell<T, any>[]): Cell<T> {
  if (cells.length === 0) throw new Error("mean: need at least one cell");
  const lin = linearOf(cells[0]);
  const n = cells.length;
  const invN = 1 / n;

  const avg = computed(() => {
    let acc = cells[0]();
    for (let i = 1; i < n; i++) acc = lin.add(acc, cells[i]());
    return lin.scale(acc, invN);
  });

  const fn: any = function (...args: any[]) {
    if (args.length === 0) return avg();
    const target = args[0];
    let curAvg = cells[0].peek();
    for (let i = 1; i < n; i++) curAvg = lin.add(curAvg, cells[i].peek());
    curAvg = lin.scale(curAvg, invN);
    const delta = lin.sub(target, curAvg);
    startBatch();
    try { for (let i = 0; i < n; i++) cells[i](lin.add(cells[i].peek(), delta)); }
    finally { endBatch(); }
  };
  return fn as Cell<T>;
}

// ── lerp — plain reactive lerp between two cells ────────────────────

export function lerp<T>(a: AnyCell<T>, b: AnyCell<T>, t: number | (() => number)): RO<T> {
  const fn = lerpOf(a);
  const tg = typeof t === "function" ? t : () => t;
  return computed(() => fn(a(), b(), tg())) as unknown as RO<T>;
}

// ── distance — plain reactive metric between two cells ──────────────

export function distance<T>(a: AnyCell<T>, b: AnyCell<T>): RO<number> {
  const fn = metricOf(a);
  return computed(() => fn(a(), b())) as unknown as RO<number>;
}

// ── springStep — per-frame spring integrator ──────────────────────
//
// Lower-level than `spring()` (in behaviors.ts) — caller owns the
// frame loop and the velocity state. Use when integrating manually
// (custom game loop or non-generator runtime). `spring()` wraps this
// with `drive(...)` for the standard generator-based API.

export function springStep<T>(
  sig: Cell<T, any>,
  target: () => T,
  velRef: { current: T },
  dt: number,
  opts: SpringOpts = {},
): boolean {
  const k = opts.stiffness ?? 100;
  const c = opts.damping ?? 10;
  const t = typeOf(sig);
  const lin = linearOf(sig);
  const m = t.metric;
  // F = -k(x - target) - c*v
  const cur = sig.peek();
  const tg = target();
  const displacement = lin.sub(cur, tg);
  const restoring = lin.scale(displacement, -k);
  const damping = lin.scale(velRef.current, -c);
  const force = lin.add(restoring, damping);
  velRef.current = lin.add(velRef.current, lin.scale(force, dt));
  const nextPos = lin.add(cur, lin.scale(velRef.current, dt));
  sig(nextPos);
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

export function serialise<T>(cell: AnyCell<T>): RO<string> {
  const t = typeOf(cell);
  const s = (t as any).serialise as Serialise<T> | undefined;
  if (!s) throw new Error(`type \`${(t as any).name ?? "?"}\` has no serialise capability`);
  return computed(() => s(cell())) as unknown as RO<string>;
}

void effect;
