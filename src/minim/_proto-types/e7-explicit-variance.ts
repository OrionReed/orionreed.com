export {};

// E7 — Explicit `out C` variance annotation.
//
// TS's measureVariance for Signal<T, C> inferred contravariance from
// the setter, which gives us the WRONG subtype direction (Vec<RO>
// assignable to Vec<RW> instead of the other way). Try forcing
// covariance with `out` and see what TS does.

declare const __ROBrand: unique symbol;
declare const __RWBrand: unique symbol;
interface RO { readonly [__ROBrand]: true }
interface RW extends RO { readonly [__RWBrand]: true }
type Cap = RO;

// Use `out` to force covariance. TS will reject if C appears in a
// contravariant position.
declare class Signal<T, out C extends Cap = RO> {
  get value(): T;
  // ↓ this puts C in a contravariant-ish position via the conditional.
  //   TS will likely complain about `out C` here.
  set value(v: C extends RW ? T : never);
  peek(): T;
}

type V = { x: number; y: number };

declare class Vec<out C extends Cap = RO> extends Signal<V, C> {
  add(b: V): Vec<C>;
  scale(k: number): Vec<C>;
  normalize(): Vec<RO>;
  get x(): Signal<number, C>;
  get y(): Signal<number, C>;
  derive<C2 extends Cap>(
    fn: (c: VecChain<RW>) => VecChain<C2>,
  ): Vec<C extends RW ? C2 : RO>;
}

declare class VecChain<out C extends Cap = RW> {
  add(b: V): VecChain<C>;
  scale(k: number): VecChain<C>;
  normalize(): VecChain<RO>;
}

declare const vec: () => Vec<RW>;

function _check() {
  const a = vec();              // Vec<RW>
  const ro = a.normalize();     // Vec<RO>

  // Want: Vec<RW> assignable to Vec<RO>  (writable IS-A readonly)
  const _x: Vec<RO> = a;        // should be OK with out C

  // Want: Vec<RO> NOT assignable to Vec<RW>
  // @ts-expect-error
  const _y: Vec<RW> = ro;

  // Want: writing to a Vec<RW>.value works
  a.value = { x: 1, y: 2 };

  // Want: writing to Vec<RO>.value FAILS at TS
  // @ts-expect-error
  ro.value = { x: 1, y: 2 };

  // Field lens inherits capability
  a.x.value = 5;
  // @ts-expect-error
  ro.x.value = 5;
}
void _check;

// Consumer patterns

function describe(v: Vec): string {
  return `(${v.value.x}, ${v.value.y})`;
}

function moveTo(v: Vec<RW>, t: V): void {
  v.value = t;
}

function _consumers() {
  const a = vec();
  const ro = a.normalize();

  describe(a);   // Vec<RW> ⊆ Vec<RO> ⇒ OK
  describe(ro);  // OK

  moveTo(a, { x: 0, y: 0 });
  // @ts-expect-error
  moveTo(ro, { x: 0, y: 0 });
}
void _consumers;

// Buggy fn — writes to its param without declaring write capability
function _buggy(v: Vec) {
  // @ts-expect-error — caught LOCALLY in the function body
  v.value = { x: 0, y: 0 };
}
void _buggy;

// CHAIN — writability propagation through derive()
function _chainFlow() {
  const a = vec();             // Vec<RW>
  const ro = a.normalize();    // Vec<RO>

  const c1 = a.derive((c) => c.add({ x: 1, y: 1 }));            // Vec<RW>
  const c2 = a.derive((c) => c.normalize());                    // Vec<RO>
  const c3 = a.derive((c) => c.add({ x: 1, y: 1 }).normalize()); // Vec<RO>
  const c4 = ro.derive((c) => c.add({ x: 1, y: 1 }));            // Vec<RO>

  // c1 is writable
  c1.value = { x: 0, y: 0 };

  // c2, c3, c4 all read-only — writes rejected
  // @ts-expect-error
  c2.value = { x: 0, y: 0 };
  // @ts-expect-error
  c3.value = { x: 0, y: 0 };
  // @ts-expect-error
  c4.value = { x: 0, y: 0 };

  // moveTo accepts c1 (writable), rejects c2/c3/c4 (RO)
  moveTo(c1, { x: 0, y: 0 });
  // @ts-expect-error
  moveTo(c2, { x: 0, y: 0 });
  // @ts-expect-error
  moveTo(c3, { x: 0, y: 0 });
  // @ts-expect-error
  moveTo(c4, { x: 0, y: 0 });
}
void _chainFlow;
