export {};

// E8 — Simpler brand types.
//
// E7 used `unique symbol` brands. They're solid but verbose: two
// `declare const` lines + two interface declarations. Try plain
// string-property brands and see if the simpler shape still gives
// the right behavior.
//
// The question: do property-key brands give enough type-level
// distinction to enforce RW ⊆ RO subtyping AND reject writes on RO?

// ─── Plain interface brands (required keys) ───────────────────────

interface RO { readonly __sig: true }       // required; runtime never assigns
interface RW extends RO { readonly __rw: true }
type Cap = RO;

declare class Signal<T, out C extends Cap = RO> {
  get value(): T;
  set value(v: C extends RW ? T : never);
  peek(): T;
  set(v: C extends RW ? T : never): this;
}

type V = { x: number; y: number };

declare class Vec<out C extends Cap = RO> extends Signal<V, C> {
  add(b: V): Vec<C>;
  normalize(): Vec<RO>;
}

declare const vec: () => Vec<RW>;

function _test() {
  const a = vec();              // Vec<RW>
  const ro = a.normalize();     // Vec<RO>

  // Want: Vec<RW> ⊆ Vec<RO>
  const _x: Vec<RO> = a;

  // Want: Vec<RO> NOT assignable to Vec<RW>
  // @ts-expect-error
  const _y: Vec<RW> = ro;

  // Writes
  a.value = { x: 1, y: 2 };
  // @ts-expect-error
  ro.value = { x: 1, y: 2 };
}
void _test;

// If this compiles cleanly (all expect-errors fire), plain property
// brands work and we don't need unique symbols.
//
// Verdict: SEE BELOW after compile.
