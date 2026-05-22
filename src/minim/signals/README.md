# @minim/signals

Reactive primitives + value classes for minim. Writability is a
generic type modifier (`Writable<R>`), animator-style constraints
reject read-only sources at compile time, and user-defined value
classes work with the same `Writable<R>` modifier — no per-class
registration needed.

## Layout

```
signal.ts          — Signal class + engine + factories (signal/computed/lens)
                     Signal#through(fwd, bwd)        — endo-lens with auto-fusion
                     Signal#lensTo(Cls, fwd, bwd)    — cross-type RW lens
                     Signal#deriveTo(Cls, fwd)       — cross-type RO lens
                     Signal#field(key, Cls)          — special case of lensTo (object prop)
                     Signal.install(Cls, g, s?)      — typed-construction primitive
                     Signal.derive / .lens / .is     — polymorphic-`this` statics inherited
                                                       by every subclass; no per-class redecl
traits.ts          — Linear / Lerp / Metric / Equals + Traits<T, K> constraint
                     traits<V>()({…})                — literal-preserving dict helper
writable.ts        — Writable<R> modifier, WritableOf<T>, invertibles<R>()
lateral.ts         — bind / eq / freeze / gated (sibling-to-sibling lenses)
anim.ts            — spring / tween / Tween / toward / attract / wave / driven / play / when / loop / every
clock.ts           — Anim → Signal bridge
values/
  num.ts           Num + num + add/sub/scale/affine + clamp/quantize/cyclic (all via .through)
  vec.ts           Vec + vec + polar + add/sub/scale/offset/up/down/left/right
  box.ts           Box + box + union + edgeFrom + at(u,v) + named edges
  transform.ts     Transform + transform (nested Vec field lenses)
  color.ts         Color + rgb/rgba + luminance + css
  matrix.ts        Matrix + matrix + multiply/invert/transformBox/...
  anchor.ts        Anchor + Dir constants
  multi.ts         combine, mean
  hyper.ts         hyperLens (N→M bidirectional)
_test/             vitest tests
```

## Authoring a value class

The shape that any value class follows:

```ts
import { Signal, valFn, type Val, type SignalOptions } from "../signal";
import { bind } from "../lateral";
import { type Linear, traits } from "../traits";
import { type Writable, invertibles } from "../writable";

type V = number;

// pure value-space functions (also serve as trait impls)
export const add = (a: V, b: V) => a + b;
// ... sub, scale, lerp, metric, equals

const linearImpl: Linear<V> = { add, sub, scale };

export class Num extends Signal<V> {
  // class-level config — `traits<V>()({…})` preserves the literal
  // trait subset so `Traits<V, "linear">` sees `linear` as present.
  static traits = traits<V>()({ linear: linearImpl, lerp, metric, equals });
  static invertibles = invertibles<Num>()("add", "sub", "scale", "through");

  // (derive / lens / is inherited from Signal — polymorphic-`this`
  // statics give `Num.derive(fn)` → Num, `Num.lens(g, s)` → Writable<Num>,
  // `Num.is(x)` → x is Num for free.)

  constructor(v: V = 0, opts?: SignalOptions<V>) { super(v, opts) }

  // Invertibles ride on Signal#through. Each chained call auto-fuses
  // to one lens cell, so .add(b).scale(k).clamp(lo,hi) is one
  // allocation, one dep-graph node.
  add(b: Val<V>): Num {
    const bf = valFn(b);
    return this.through(v => v + bf(), n => n - bf());
  }
  // ... sub, scale, etc. follow the same shape
}
// interface merge: RO at the public type level; Writable<Num> surfaces the writes
export interface Num {
  readonly constructor: typeof Num;
  get value(): V;
}
export function num(v: Val<V> = 0): Writable<Num> {
  const n = new Num() as unknown as Writable<Num>;
  bind(n, v);
  return n;
}
```

That's the entire mechanical pattern. Field lenses (when relevant)
go after methods as `get x(): Num { return this.field("x", Num) }`.

`.through(fwd, bwd)` is the one primitive every invertible method
should reach for. It's an endo-lens (T → T) with two arms in
value-space; consecutive `.through()` calls auto-fuse so chains stay
flat. For non-trivial cases (lossy projections, cyclic reps,
parameterised inverses) the same shape applies — see `Num.clamp` /
`Num.quantize` / `Num.cyclic` for examples.

## Writability tracking

- **Factories return writable**: `vec(...)`, `num(...)`, `box(...)`, `Vec.lens(...)`, `signal(...)` etc. all return `Writable<R>` (or `Signal<T> & WritableBrand` for raw signals).
- **Derived methods return RO**: `vec.normalize()`, `Vec.derive(fn)`, `computed(fn)` return bare class types (read-only at the type level).
- **Invertible methods preserve writability**: `Writable<Vec>.add(b).scale(2)` is `Writable<Vec>` (chain stays writable).
- **Field lenses auto-promote**: `Writable<Vec>.x` is `Writable<Num>`; bare `Vec.x` is `Num`.

## Animator constraints

```ts
function spring<T>(s: WritableOf<T> & Traits<T, "linear" | "metric">, target: T): void
function tween<T>(s: WritableOf<T> & Traits<T, "lerp">, target: T, dur: Val<number>): Tween<T>
function attract<T>(s: WritableOf<T> & Traits<T, "linear">, target: Val<T>, k?: Val<number>): Animator<void>
```

`WritableOf<T>` is the T-anchored writable constraint with brand.
Bare RO `Vec` / `Num` instances are rejected at compile time.

## User-defined value classes

The `Writable<R>` modifier is fully generic — no library changes
needed to add new value classes. Field-lens auto-promotion works
recursively. See `_test/extensibility.test.ts` for an `Hsl` example.

## Caveats / footguns

1. **Bare `(p: Vec)` parameter doesn't accept `Writable<Vec>`**
   cleanly due to TS recursive variance. Use `Read<{x,y}>` or
   `Read<Of<Vec>>` for "any read source of vec shape". Documented in
   the `_test/types.test.ts`.

2. **`new Vec()` produces a bare unbranded Vec.** Convention: always
   use the factory (`vec(...)`) — it casts to add the brand.

3. **`Tween` chainable `.to(...)` casts `this as never`** internally
   to bypass the `WritableBrand` requirement on `tween()`. The cast
   is safe because `.to` is on writable receivers in practice (the
   factories return writable). If you construct a value class
   directly with `new Foo()`, calling `.to` would runtime-work but
   skips the type-level brand check.
