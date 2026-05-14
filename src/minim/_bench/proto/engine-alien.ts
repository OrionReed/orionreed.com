// Alien-signals backed engine. Alien's primitive is a callable function:
//
//   const s = signal(0);
//   s();           // tracked read
//   s(42);         // write
//
// The Ref<T> here just IS that callable function. read/write/peek
// dispatch by calling vs not-calling-with-an-arg.
//
// Alien doesn't expose batch as a wrapper; it has start/endBatch
// counters. We compose them into a batch(fn) helper.
//
// Alien doesn't have a built-in peek either — we shadow `activeSub`
// using its `setActiveSub` to do an untracked read.

import {
  signal as aSignal,
  computed as aComputed,
  effect as aEffect,
  startBatch,
  endBatch,
  setActiveSub,
  isSignal,
} from "./alien";
import type { Engine, Ref } from "./engine";

function toRef<T>(fn: unknown): Ref<T> {
  return fn as unknown as Ref<T>;
}

function fnOf<T>(ref: Ref<T>): (...args: any[]) => any {
  return ref as unknown as (...args: any[]) => any;
}

export const alienEngine: Engine = {
  name: "alien",
  signal<T>(initial: T, opts?: { equals?: (a: T, b: T) => boolean }): Ref<T> {
    // alien's signal compares with === only. equals hint is ignored
    // for this experiment; could wrap with a guard if needed.
    void opts;
    return toRef(aSignal(initial));
  },
  computed<T>(fn: () => T): Ref<T> {
    return toRef(aComputed(fn));
  },
  lens<T>(r: () => T, w: (v: T) => void): Ref<T> {
    // Alien has no built-in lens. Synthesize: read via a computed (so
    // dependencies on `r`'s sources track correctly), write by calling
    // the user-supplied writer (which is expected to mutate an
    // upstream signal; propagation is automatic).
    const reader = aComputed(r);
    const fn = function (...args: any[]) {
      if (args.length === 0) return reader();
      w(args[0]);
    };
    (fn as any).__isLens = true;
    return toRef(fn);
  },
  effect(fn) {
    return aEffect(fn as any);
  },
  batch<T>(fn: () => T): T {
    startBatch();
    try {
      return fn();
    } finally {
      endBatch();
    }
  },
  read<T>(ref: Ref<T>): T {
    return fnOf(ref)() as T;
  },
  write<T>(ref: Ref<T>, v: T): void {
    fnOf(ref)(v);
  },
  peek<T>(ref: Ref<T>): T {
    // Suppress dep tracking by clearing activeSub during the read.
    const prev = setActiveSub(undefined);
    try {
      return fnOf(ref)() as T;
    } finally {
      setActiveSub(prev);
    }
  },
  isWritable<T>(ref: Ref<T>): boolean {
    const fn = fnOf(ref);
    return (fn as any).__isLens === true || isSignal(fn as () => void);
  },
};
