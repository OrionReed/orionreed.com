// index.ts — exports for the symmetric prototype.

export {
  Signal,
  signal,
  computed,
  effect,
  batch,
  type MergePolicy,
  DIRECT_SLOT,
} from "./signal";

// Test helpers (peek bwd state).
import type { Signal } from "./signal";

export function peekBwdParent(cell: Signal<unknown>): Signal<unknown> | undefined {
  return cell._bwdParent;
}

export function peekMergeAcc<T>(cell: Signal<T>): T | undefined {
  return cell._mergeNode?.acc;
}

export function peekMergeSlots<T>(cell: Signal<T>): Map<unknown, T> | undefined {
  return cell._mergeNode?.slots;
}

// Common policies for tests.
export const sumPolicy = {
  identity: 0,
  combine: (a: number, b: number) => a + b,
  remove: (a: number, b: number) => a - b,
};

export const productPolicy = {
  identity: 1,
  combine: (a: number, b: number) => a * b,
  remove: (a: number, b: number) => a / b,
};

export const maxPolicy = {
  identity: Number.NEGATIVE_INFINITY,
  combine: (a: number, b: number) => Math.max(a, b),
};
