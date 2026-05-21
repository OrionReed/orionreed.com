# Type-system exploration: writability encoding

Seven self-contained TS files exploring how to encode "this signal is
read-only" in the type system. Each is an isolated module with
`@ts-expect-error` markers proving TS rejects what we want rejected —
if a marker doesn't fire (unused-directive error), the encoding has a
silent hole.

**Winner: E7** — branded capability types + `out C` variance
annotation. Combines all the properties we want:
- Read-only by default (local-reasoning, lazy code is safe code)
- Writable IS-A read-only via covariance
- Setter rejects writes on RO at TS compile time
- Chain writability propagates automatically through `derive()`
- Field lenses inherit parent's capability

## The encodings, in order tried

| file | shape | result |
|---|---|---|
| `e1-builtin-readonly.ts` | TS built-in `Readonly<T>` | **fails** — only marks properties readonly, doesn't block `.set()` |
| `e2-writable-default.ts` | Writable default + `Readonly<R>` Omit narrowing | ✓ but writable-default has non-local pressure |
| `e3-readonly-default.ts` | RO default + `Writable<R>` intersection adds setters | ✓ local-reasoning win, but no chain writability tracking |
| `e4-variance.ts` | `Signal<T, W extends boolean>` phantom param | ✓ chain tracking works, but `Vec<true>` not assignable to `Vec<false>` (boolean lits are disjoint) |
| `e5-combined.ts` | E4 internally + E3 surface (writable default) | ✓ same variance issue as E4 |
| `e6-branded-cap.ts` | E4 with branded `RO`/`RW extends RO` types | ✓ structural subtyping works for moveTo, but contravariance from setter breaks chain |
| `e7-explicit-variance.ts` | E6 + explicit `out C` annotation on Signal/Vec | **✓ everything works** |

## E7 — the design

```ts
// Capability brands — required symbol fields, runtime-absent, type-only.
declare const __ROBrand: unique symbol;
declare const __RWBrand: unique symbol;
interface RO { readonly [__ROBrand]: true }
interface RW extends RO { readonly [__RWBrand]: true }
type Cap = RO;  // default

class Signal<T, out C extends Cap = RO> {
  get value(): T;
  // Conditional setter: T for writable, never for read-only.
  // `out C` annotation declares C is covariant, so the contravariant
  // setter doesn't flip the subtype direction (Vec<RW> ⊆ Vec<RO>).
  set value(v: C extends RW ? T : never);
  peek(): T;
  set(v: C extends RW ? T : never): this;
  bind(source: (C extends RW ? T : never) | (() => (C extends RW ? T : never))): () => void;
}

class Vec<out C extends Cap = RO> extends Signal<V, C> {
  add(b: V): Vec<C>;             // invertible — preserves C
  scale(k: number): Vec<C>;
  normalize(): Vec<RO>;          // non-invertible — narrows to RO
  get x(): Signal<number, C>;    // field lens inherits parent's C
  derive<C2 extends Cap>(
    fn: (c: VecChain<RW>) => VecChain<C2>,
  ): Vec<C extends RW ? C2 : RO>;  // chain propagates capability
}

class VecChain<out C extends Cap = RW> {
  add(b: V): VecChain<C>;
  normalize(): VecChain<RO>;
}

// Aliases for readability:
type Writable<R> = R extends Vec<Cap> ? Vec<RW> : never;  // (extend per value class)

// Factory returns the writable form:
const vec: () => Vec<RW>;
```

## All the properties this gets

### 1. RO default (local-reasoning win)

```ts
function buggy(v: Vec) {
  // @ts-expect-error — TS catches this IN the function body
  v.value = { x: 0, y: 0 };
}
```

The pressure to widen is **local**. You fix the one function that
genuinely needs write access by changing its signature to `Vec<RW>`.
Callers are unaffected.

### 2. Writable IS-A read-only via covariance

```ts
const a = vec();            // Vec<RW>
const b: Vec<RO> = a;       // OK — Vec<RW> ⊆ Vec<RO>
const _x = b.value;         // can read

// But not the reverse:
const ro: Vec<RO> = vec().normalize();
// @ts-expect-error — Vec<RO> NOT assignable to Vec<RW>
const _y: Vec<RW> = ro;
```

The `out C` annotation makes Vec covariant in C even though C
appears (via the conditional) in the setter's parameter position.
TS allows this because the conditional's evaluation is constant
when C is concrete (resolves to T or never), and never-on-RO
doesn't actually require contravariance.

### 3. Setter rejects writes on RO at TS level

```ts
const a = vec();             // Vec<RW>
a.value = { x: 1, y: 2 };    // OK

const ro = a.normalize();    // Vec<RO>
// @ts-expect-error
ro.value = { x: 1, y: 2 };
// @ts-expect-error
ro.set({ x: 1, y: 2 });
```

The conditional `C extends RW ? T : never` evaluates to `never` for
RO, so the setter takes no possible value. Write attempts are TS
errors.

### 4. Chain writability propagates automatically

```ts
const a = vec();
const c1 = a.derive((c) => c.add({ x: 1, y: 1 }));            // Vec<RW>
const c2 = a.derive((c) => c.normalize());                    // Vec<RO>
const c3 = a.derive((c) => c.add({ x: 1, y: 1 }).normalize()); // Vec<RO>

// From an RO source — even invertible chains can't recover writability
const ro = a.normalize();
const c4 = ro.derive((c) => c.add({ x: 1, y: 1 }));           // Vec<RO>
```

`derive`'s return type is `Vec<C extends RW ? C2 : RO>` — the chain's
inferred C2 only matters if the source was writable; otherwise the
whole thing is RO.

### 5. Field lenses inherit capability

```ts
const a = vec();             // Vec<RW>
a.x.value = 5;               // OK — a.x is Signal<number, RW>

const ro = a.normalize();    // Vec<RO>
// @ts-expect-error
ro.x.value = 5;              // ro.x is Signal<number, RO>
```

`get x(): Signal<number, C>` threads C through. Reading via `.x` is
always fine; writing only on writable sources.

## Cost summary

**Author cost:**
- Each value class: declare `class Vec<out C extends Cap = RO> extends Signal<V, C>`. Once per class.
- Each invertible method: `add(b): Vec<C>` (instead of `add(b): Vec`).
- Each non-invertible method: `normalize(): Vec<RO>`.
- Each chain: `class VecChain<out C extends Cap = RW>` + per-method preserving or narrowing.

Total: maybe 15–20 extra characters per method, plus the class declaration line.

**Consumer cost:**
- Read-only sig: `function describe(v: Vec)` — no change from today.
- Write-needed sig: `function moveTo(v: Vec<RW>, target: V)` or
  `function moveTo(v: Writable<Vec>, target: V)` — one extra word.
- Generic sig accepting either: `function distance(a: Vec, b: Vec)` — no change.

Total: most consumer signatures unchanged. Write-needing ones grow by one word.

**Runtime cost:** zero. Brand types are type-level only; `out C` is a compile-time annotation.

## Migration plan if we ship E7

1. **Define brands + Signal class** in `signal.ts` (1 hour). Verify
   the `out C` annotation is accepted; spot-check that conditional
   setters reject writes as expected.
2. **Add `<out C extends Cap = RO>` to each value class** (Num, Vec,
   Box, Color, Matrix, Transform) (~30 min each). Update method
   signatures to thread C.
3. **Convert factories to return Vec<RW>** etc. Should be a one-line
   change per factory.
4. **Add chain capability tracking** in ops.ts and each chain class
   (~1 hour).
5. **Sweep consumer code**: most signatures stay the same; the
   write-needing ones (handles, shapes that mutate translate, etc.)
   gain `Vec<RW>` (~20 sites in shapes/, ~10 in elements/).
6. **Move dropping `type VecValue = Of<Vec>` aliases** (your earlier
   ask). Now `Of<Vec>` is the canonical name.

Estimated total: 4–6 hours, mostly mechanical, fully type-checked
end-to-end.

## Quick verification

```bash
npx tsc --noEmit src/minim/_proto-types/e7-explicit-variance.ts
# clean — every @ts-expect-error fires correctly
```

## Footnote: why we needed brands instead of boolean

Boolean literals (`true`, `false`) are disjoint types — TS doesn't
treat `true` as a subtype of `false` or vice versa. So `Vec<true>`
and `Vec<false>` are unrelated.

Brand types with `RW extends RO` get us structural subtyping for
free: anything tagged RW also satisfies RO's constraints. That's the
foundation for the variance trick.

The `out C` annotation closes the loop: by declaring C covariant,
TS doesn't infer contravariance from the conditional setter and the
subtype direction is preserved.
