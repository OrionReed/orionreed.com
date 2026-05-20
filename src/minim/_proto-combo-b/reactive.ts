// Combo B: alien-wrapped engine + merged Reactive class.
//
// Single `Reactive<T>` class. Three modes determined by which fields
// are set:
//   - signal mode:   `_alien` = alien-signals signal (writable)
//   - computed mode: `_alien` = alien-signals computed (read-only)
//   - lens mode:     `_alien` = computed + `_setter` set
//
// `derived(Cls, fn, setter?)` is ~5 lines — no viewClassFor, no
// setPrototypeOf, no class synthesis. `Cls extends Reactive` naturally,
// `instanceof Cls` uses native chain walk.
//
// Equality preservation: alien uses `!==` only. To keep minim's
// `[EQUALS]` trait semantics (structural equality for Vec etc.), we
// short-circuit equal writes in `set value`.

import {
  signal as aSignal,
  computed as aComputed,
  effect as aEffect,
  startBatch,
  endBatch,
  setActiveSub,
} from "alien-signals";

import { EQUALS, type Equals } from "../signals/traits";

// Alien's callable type. Generic over T; signal mode accepts `[T]`,
// computed mode accepts `[]` (read-only).
type AlienFn<T> = ((...args: [T] | []) => T | void) & { length: number };

// ─── The class ───────────────────────────────────────────────────────

export class Reactive<T = unknown> {
  /** @internal — alien-signals callable; writable in signal mode,
   *  read-only in computed/lens mode. */
  _alien!: AlienFn<T>;

  /** @internal — for lens mode (write delegation). */
  _setter?: (v: T) => void;

  /** @internal — true for plain signals; false for computed/lens
   *  (set by `derived()`/`computed()`/`lens()`). */
  _writable: boolean = true;

  /** @internal — caller (e.g. `derived`) passes false to skip alien
   *  signal allocation when about to override with computed. */
  constructor(initial?: T, _skipInit: boolean = false) {
    if (!_skipInit) {
      this._alien = aSignal(initial as T) as AlienFn<T>;
    }
  }

  /** Read with tracking. Single property access + getter + alien call.
   *  Caps at ~4 ns due to JS getter overhead, but inherits alien's
   *  algorithm. */
  get value(): T {
    return this._alien() as T;
  }

  /** Write. Honors `[EQUALS]` trait for structural equality
   *  short-circuit (Vec, Box, etc. — alien only does `!==`). */
  set value(next: T) {
    // Lens mode: route through user setter
    if (this._setter !== undefined) {
      this._setter(next);
      return;
    }
    // Computed without setter — readonly
    if (!this._writable) {
      throw new TypeError("Cannot write to a Computed");
    }
    // Structural equality short-circuit for value types (alien only !==).
    // The `this._alien()` read here is untracked (we're not inside an
    // active sub when called from the setter), so no false subscribe.
    const equals = (this as unknown as { [EQUALS]?: Equals<T> })[EQUALS];
    if (equals !== undefined) {
      const prev = setActiveSub(undefined);
      try {
        const cur = this._alien() as T;
        if (equals(cur, next)) return;
      } finally {
        setActiveSub(prev);
      }
    }
    this._alien(next);
  }

  /** Untracked read. */
  peek(): T {
    const prev = setActiveSub(undefined);
    try { return this._alien() as T; }
    finally { setActiveSub(prev); }
  }

  /** One-shot write; returns `this` for chaining. */
  set(v: T | Reactive<T> | (() => T)): this {
    this.value = value(v);
    return this;
  }

  /** Bind this signal to a source (one-way reactive copy). Returns disposer. */
  bind(source: T | Reactive<T> | (() => T)): () => void {
    if (source instanceof Reactive || typeof source === "function") {
      return effect(() => { this.value = value(source); });
    }
    this.value = source as T;
    return () => {};
  }

  [Symbol.toPrimitive](hint: string): never {
    throw new TypeError(`Reactive cannot be coerced to ${hint} — use \`.value\``);
  }
}

// ─── Public factories ────────────────────────────────────────────────

export function signal<T>(initial: T): Reactive<T> {
  return new Reactive(initial);
}

export function computed<T>(getter: () => T): Reactive<T> {
  const r = new Reactive<T>(undefined, true);
  r._alien = aComputed(getter) as AlienFn<T>;
  r._writable = false;
  return r;
}

export function lens<T>(getter: () => T, setter: (v: T) => void): Reactive<T> {
  const r = new Reactive<T>(undefined, true);
  r._alien = aComputed(getter) as AlienFn<T>;
  r._setter = setter;
  // _writable stays true conceptually — write goes through _setter.
  return r;
}

export function effect(fn: () => void | (() => void)): () => void {
  return aEffect(fn);
}

export function batch<R>(fn: () => R): R {
  startBatch();
  try { return fn(); }
  finally { endBatch(); }
}

export function untracked<R>(fn: () => R): R {
  const prev = setActiveSub(undefined);
  try { return fn(); }
  finally { setActiveSub(prev); }
}

// ─── derived(Cls, fn, setter?) — 5 lines, no viewClassFor ───────────

/**
 * Construct a Reactive subclass instance backed by a computed getter
 * (and optional setter for lens behavior).
 *
 * Because Cls extends Reactive — which already has all the machinery —
 * we just `new Cls()`, override `_alien` with a computed, and (for
 * lenses) set `_setter`. No class synthesis. `instanceof Cls` works
 * via native prototype chain.
 */
export function derived<T, C extends Reactive<T>>(
  Cls: new (...args: never[]) => C,
  fn: () => T,
  setter?: (v: T) => void,
): C {
  const inst = new Cls();
  // Overwrite the signal-mode alien (created by Cls constructor) with
  // an alien computed. The wasted alien-signal allocation is one extra
  // alloc per derived — small price for the API simplicity.
  inst._alien = aComputed(fn) as AlienFn<T>;
  if (setter !== undefined) inst._setter = setter;
  else inst._writable = false;
  return inst;
}

// ─── Helpers ─────────────────────────────────────────────────────────

export type Val<T> = T | (() => T) | Reactive<T>;

export function value<T>(v: Val<T>): T {
  if (v instanceof Reactive) return v.value;
  if (typeof v === "function") return (v as () => T)();
  return v as T;
}

export const isSignal = (v: unknown): v is Reactive<unknown> => v instanceof Reactive;
