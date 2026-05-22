// _proto-exp/traversal.ts — reactive collections via the traversal
// optic.
//
// Today's signals operate on single values; there's NO collection
// reactivity. Classical optics has a "Traversal" — a lens with N foci.
// In reactive terms: a collection cell that lets you observe per-item
// changes, structural changes (add/remove/reorder), and write through
// to specific elements.
//
// Sketch design:
//
//   listSignal([...])   — source-style collection
//   list.value           — the underlying T[] (whole-array semantics)
//   list.length          — reactive Num4 (always in sync with value)
//   list.at(i)           — Cell<T> that observes index i (RW)
//   list.each(fn)        — reactive iteration with stable subscription
//   list.push(v) / list.remove(i) — structural ops
//
// The traversal lens lets us chain: `list.at(i).through(...)` etc.
// All the usual lens-algebra operations apply.

import { Source, Derived } from "../_proto-cell2/cell2";
import { Num4 } from "../_proto-cell4/num4";

export class ListSignal<T> {
  static is(v: unknown): v is ListSignal<unknown> { return v instanceof ListSignal }

  /** The backing source. Reads return the array; writes replace it. */
  _cell: Source<readonly T[]>;
  /** Memoized per-index cell views, so identity is stable across reads. */
  _itemCells = new Map<number, Source<T> | Derived<T>>();
  /** Memoized length view. */
  _lengthCell?: Num4;

  constructor(initial: readonly T[] = []) {
    this._cell = new Source(initial);
  }

  get value(): readonly T[] { return this._cell.value }
  set value(v: readonly T[]) { this._cell.value = v }
  peek(): readonly T[] { return this._cell.peek() }

  get length(): Num4 {
    if (this._lengthCell) return this._lengthCell;
    return (this._lengthCell = new Num4(new Derived(() => this._cell.value.length)));
  }

  /** Per-index lens. Read returns the element; write replaces it.
   *  Returns a stable cell identity per index — so subscribers see
   *  the same cell across reads. */
  at(i: number): Derived<T> {
    let c = this._itemCells.get(i);
    if (c !== undefined) return c as Derived<T>;
    c = new Derived<T>(
      () => this._cell.value[i],
      (v) => {
        const arr = this._cell.peek();
        if (i < 0 || i >= arr.length) throw new RangeError(`at(${i}): out of bounds`);
        const next = arr.slice();
        next[i] = v;
        this._cell.value = next;
      },
    );
    this._itemCells.set(i, c);
    return c as Derived<T>;
  }

  /** Iterate reactively. The callback runs once per (item, index) pair
   *  and re-runs when the array's structural shape changes (length,
   *  identity of elements at indices). For per-item reactivity in a
   *  deeper way, use `.at(i)` on each index and observe that. */
  each<R>(fn: (item: T, i: number) => R): readonly R[] {
    const arr = this._cell.value;
    const out: R[] = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = fn(arr[i], i);
    return out;
  }

  /** Structural ops — these update the source, dropping per-index
   *  cell identity for shifted indices. Subscribers via .at(i) will
   *  observe new values (the dep graph still fires correctly). */
  push(v: T): void {
    this._cell.value = [...this._cell.peek(), v];
  }

  pop(): T | undefined {
    const arr = this._cell.peek();
    if (arr.length === 0) return undefined;
    const next = arr.slice(0, arr.length - 1);
    const tail = arr[arr.length - 1];
    this._cell.value = next;
    return tail;
  }

  removeAt(i: number): void {
    const arr = this._cell.peek();
    if (i < 0 || i >= arr.length) return;
    const next = arr.slice();
    next.splice(i, 1);
    this._cell.value = next;
  }

  insertAt(i: number, v: T): void {
    const arr = this._cell.peek();
    const next = arr.slice();
    next.splice(i, 0, v);
    this._cell.value = next;
  }
}

export function list<T>(initial: readonly T[] = []): ListSignal<T> {
  return new ListSignal(initial);
}
