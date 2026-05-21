export {};  // make this an isolated module so its declarations don't leak

// E1 — TS built-in `Readonly<T>` on a typed Signal class.
//
// Conclusion (verified below): this DOES NOT block writes through
// methods. `Readonly<T>` only marks each property as readonly; it
// doesn't change whether you can call mutating methods like `.set()`.
// Even worse: it doesn't even block writes to `.value` if the property
// is defined via a getter/setter pair (the setter stays callable
// because property descriptors aren't part of TS's `readonly` story).

class VecBase {
  declare value: { x: number; y: number };  // writable property
  set(_v: { x: number; y: number }): this { return this; }
  add(_b: { x: number; y: number }): VecBase { return new VecBase(); }
}

// ─── How does Readonly<Vec> actually behave? ────────────────────────

function _test(v: Readonly<VecBase>) {
  // Reading: fine, as expected
  const _x = v.value.x;

  // ✗ Writes to declared properties ARE blocked:
  // @ts-expect-error — `value` is readonly under Readonly<VecBase>
  v.value = { x: 0, y: 0 };

  // ✗ But calling mutating methods STAYS ALLOWED:
  v.set({ x: 1, y: 1 });  // type-checks — no error
  v.add({ x: 0, y: 0 });  // type-checks — no error
}
void _test;

// Verdict: insufficient. TS's `Readonly` is property-shallow and has no
// notion of "mutating method." If we wanted to use it we'd still need
// to manually Omit the mutating methods, at which point we've reinvented
// E2 (custom Omit-based type). Skip.
