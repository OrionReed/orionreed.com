// bind.ts (spike) — same shape as today's `bind`. Brand-gated on the
// target so bare RO classes are rejected at the call site (the
// `brand-redundancy.test.ts` probe demonstrated structural RO/RW
// alone is too lenient at parameter sites).

import { effect, Signal, type Val, value, type WritableBrand } from "../signal";

interface RW<T> {
  value: T;
  peek(): T;
}

export function bind<T>(target: RW<T> & WritableBrand, source: Val<T>): () => void {
  if (source instanceof Signal || typeof source === "function") {
    return effect(() => {
      target.value = value(source);
    });
  }
  target.value = source as T;
  return () => {};
}
