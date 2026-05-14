// Preact-backed engine — wraps the project's vendored preact-signals
// slice (which `@minim/signals` already exposes).

import {
  signal as pSignal,
  computed as pComputed,
  effect as pEffect,
  batch as pBatch,
  lens as pLens,
} from "@minim/signals";
import type { Engine, Ref } from "./engine";

function toRef<T>(s: unknown): Ref<T> {
  return s as unknown as Ref<T>;
}

function fromRef<T>(r: Ref<T>): any {
  return r as unknown as any;
}

export const preactEngine: Engine = {
  name: "preact",
  signal<T>(initial: T, opts?: { equals?: (a: T, b: T) => boolean }): Ref<T> {
    return toRef(pSignal(initial, opts));
  },
  computed<T>(fn: () => T): Ref<T> {
    return toRef(pComputed(fn));
  },
  lens<T>(r: () => T, w: (v: T) => void): Ref<T> {
    return toRef(pLens(r, w));
  },
  effect(fn) {
    return pEffect(fn as any);
  },
  batch<T>(fn: () => T): T {
    return pBatch(fn);
  },
  read<T>(ref: Ref<T>): T {
    return fromRef(ref).value;
  },
  write<T>(ref: Ref<T>, v: T): void {
    fromRef(ref).value = v;
  },
  peek<T>(ref: Ref<T>): T {
    return fromRef(ref).peek();
  },
  isWritable<T>(ref: Ref<T>): boolean {
    // preact's Signal class has a writable `value` setter; Computed
    // throws. Cheap structural check via descriptor name.
    const s = fromRef(ref);
    return s.constructor && s.constructor.name === "Signal";
  },
};
