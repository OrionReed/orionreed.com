/////// Me:
Looking at the code:

- is there a way to simplify or eliminate the helpers for composites? do it more directly?
- is there a way for the traits to reference its own struct? i.e. if we have the linear ops as part of the struct methods, can we make it easy to re-use those? (no auto-magic)
- no need to shadow bind(), we can just use a different name.
- the reserved throw is a simple util that can be reused
- the code still has "delete cell.name"
- curious your thoughts on what feels hacky or smelly. im sure theres quite a bit, be highly critical please

//////// Them:

Going through your points honestly, then a brutal smell pass.

**1. Eliminating composite helpers / doing it directly**

The helpers (`compositeLerp`, `compositeLinear`, `compositeMetric`) exist to walk a field map and combine each field's trait. Today the user writes them out twice — once in the fieldMap declaration, once implicitly through `.value`. That's the duplication.

If the framework knows the value's shape (it does — from `cfg.value`), it can derive the field-to-type map itself. Each entry in `value` that's a TypeProto contributes its trait at that key; each primitive contributes a fallback (numeric add/sub for `linear`, abs-diff for `metric`, identity-lerp for `lerp`).

So instead of:

```ts
const fieldMap = { translate: Vec, scale: Vec, rotate: "num", opacity: "num" };
const Transform = struct({
  type: "Transform",
  value: { translate: Vec, scale: Vec({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
  traits: {
    linear: compositeLinear<Tr>(fieldMap as any),
    lerp: compositeLerp<Tr>(fieldMap as any),
    metric: compositeMetric<Tr>(fieldMap as any),
  },
});
```

You could write a single inline helper that introspects the value:

```ts
const Transform = struct({
  type: "Transform",
  value: { translate: Vec, scale: Vec({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
  traits: combine("linear", "lerp", "metric"), // synthesize from value's fields
});
```

`combine(...traitNames)` is one function. Given access to the value spec (passed at struct-definition time, or accepting it as a second arg), it walks the value once and produces a `Traits` record where each named trait is composited from the fields.

Even better: `combine` doesn't need to be a marker — the framework can do this whenever `traits` declares a capability that _isn't_ a function. So `traits: { lerp: "compose" }` says "compose lerp from fields." Or use a sentinel like `compose.lerp` to keep typing.

Simplest version: drop the per-trait helpers entirely, add one method on the result of `struct()` that synthesizes traits:

```ts
const Transform = struct({
  type: "Transform",
  value: { translate: Vec, scale: Vec({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
}).withCompositeTraits("linear", "lerp", "metric");
```

I dislike the chained API. Better: make it a config field:

```ts
const Transform = struct({
  type: "Transform",
  value: { translate: Vec, scale: Vec({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
  compose: ["linear", "lerp", "metric"],
});
```

`compose` is a list of trait names to synthesize from fields. The framework walks `value` at struct-definition time, for each name builds the composite, installs it in `traits`. If the user also declared `traits.lerp` explicitly, that one wins (no override; the user has spoken).

Now there's one declarative slot, no helpers, no fieldMap duplication, no per-trait factory functions. Three lines collapse to one.

The helpers can stay as exports for users who want to compose by hand for some reason, but they're no longer the primary path.

**2. Trait referencing its own struct**

Right now, if the user writes the linear trait by hand for Vec, they write `add(a, b) => ({x: a.x + b.x, y: a.y + b.y})`. The struct's own methods don't help — they operate on cells (with `this`), not on plain values.

The cleanest way to enable re-use: have the user write their value-level operations ONCE, and let traits and methods both reference them. Like:

```ts
const Vec = struct({
  type: "Vec",
  value: { x: 0, y: 0 },
  ops: {
    // pure functions on plain values
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
    dot: (a, b) => a.x * b.x + a.y * b.y,
  },
  traits: {
    linear: {
      add: (ops) => ops.add,
      sub: (ops) => ops.sub,
      scale: (ops) => ops.scale,
    },
    // ... or simpler
  },
});
```

But the indirection (`ops => ops.add`) is awful. Let me try another shape.

What about: traits is a _function_ that receives the ops bag?

```ts
const Vec = struct({
  type: "Vec",
  value: { x: 0, y: 0 },
  ops: {
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
    lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
    dot: (a, b) => a.x * b.x + a.y * b.y,
  },
  traits: (ops) => ({
    linear: { add: ops.add, sub: ops.sub, scale: ops.scale },
    lerp: ops.lerp,
    metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
    equals: (a, b) => a.x === b.x && a.y === b.y,
  }),
});
```

The `traits` field can be either a plain object (current form) or a function receiving the ops bag. The function form gives the user access to their own ops to compose traits.

This also serves point (1) — composite synthesis could be expressed in the same closure:

```ts
const Transform = struct({
  type: "Transform",
  value: { translate: Vec, scale: Vec({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
  traits: (ops, fields) => ({
    linear: composeLinear(fields), // synthesize from typed fields
    lerp: composeLerp(fields),
    metric: composeMetric(fields),
  }),
});
```

But that's just helpers again. Hmm.

Actually, I think the cleanest version is: the `compose` config slot for synthesis, AND the function-form for `traits` (or stick with object form — the function form is sugar). Plus `ops` as a separate slot for pure value-level operations that _both_ methods and traits can reference.

The `ops` slot is where I'd push hardest. It lets the user write the value-level math once and reuse it. Traits become trivially expressible. And it composes with everything else.

For methods that need to operate on cells, they can also reference ops:

```ts
methods: (ops) => ({
  invert(this) {
    this(ops.scale(this(), -1));
  },
});
```

Same pattern: methods is a function over ops. Or just have methods reach `cell.traits.linear.scale` — they have access to it.

I think I'd commit to: `ops` as a config slot for pure operations, `traits` as either object or function-of-ops, `methods` accessing `this.traits` for the trait functions or referencing ops directly via closure.

This pushes "the linear ops as part of the struct methods" toward the right shape — they're not "methods" in the JS sense, they're operations declared once and used multiple ways.

**3. Don't shadow `bind()`**

Right. Pick a different name. Candidates:

- `follow` — semantically nice ("A.opacity follows C.x"). Reads well.
- `track` — overloaded with reactive tracking.
- `link` — fine, mild.
- `attach` — too generic.
- `sub` / `subscribe` — overloaded with effect.
- `wire` — physical metaphor, nice.

I'd go with `follow` for one-way and `sync` for two-way (replacing `mirror`). Reads as English: `A.opacity.follow(C.x)`, `m1.sync(m2)`.

Or: `<- and <->` style — `from(otherSignal)` for one-way (this signal gets its value FROM other), and `with(otherSignal)` for two-way. `A.opacity.from(C.x)` — concise.

I'll commit to `follow` and `sync` for the report. They read clearly and don't collide.

**4. Reserved-throw as a util**

Yes — `reserved.guard(name, "method")` or similar. One place to update the set, one place to format the error. Worth doing.

**5. The `delete cell.name` is still there**

You're right. With `type` as the property name (instead of `name`), `delete cell.name` is no longer needed for the type lookup to work — but the cell still has its own `name` slot from being a Function. It just doesn't matter for our purposes since we never read `cell.name`. The `delete` is dead code. Should be removed.

**6. Smell pass — being properly critical**

Now the brutal part. Going through `lib.ts` honestly:

_The four-form dispatch in cell construction._ Form A, B, C, D — function value, composite literal, primitive-only literal, scalar primitive. This is a `if/else if/else if/else` chain with overlapping detection logic (`isTypeProto`, `isCell`, `typeof === object`, `null` check). The code makes a different choice in each branch. This is the smelliest part of the file.

The cleanup: there should be ONE construction path that walks the value and decides per-field. Form B _already_ does the per-field decision (typed sub-cell, cell instance, primitive). Form C (the all-primitive lens path) is a perf-optimization branch that does something different for "ergonomics and perf." Form D (scalar) is a special case for when value isn't an object at all.

Honest answer: Form C shouldn't be the default. Form B with primitive-fields-as-`signal(v)` is simpler and uniform. The lens-over-one-signal pattern is a perf optimization users can opt into explicitly, perhaps via `value: shared({x: 0, y: 0})` or `value: lens({x: 0, y: 0})` — a marker that says "store these together, expose as lenses." Otherwise default to per-field signals.

This collapses Form C into Form B with the marker variant, and gives users an explicit, opt-in perf hint. The dispatch chain shrinks.

Form D (scalar primitive like `value: 0`) is also genuinely special — but maybe it should just route through `signal(0)` directly without invoking struct at all. Or maybe struct doesn't even accept scalar values — for those, users write `signal(0)` and skip struct.

Actually that's the cleanest answer: **struct is for _named-field_ values**. Anything without named fields uses `signal()` directly. Form D goes away.

_The `isTypeProto`/`isCell` detection._ These use ownership checks. They're fine but fragile to anyone passing in an object that happens to have a `type` string and `traits` field. There's no nominal typing — users who construct their own type-shaped objects would slip through.

The fix would be a brand symbol — `STRUCT_BRAND = Symbol()` on every TypeProto, checked instead of duck-typing. Small change, removes ambiguity.

_The `staticFieldNames` was carried over from prior code_ — I see I removed the `else if (isLiteral && ...)` branch but left this in the closure. Dead unused variable in the current state. Should remove.

_The `mirror` setup-direction hack._ On setup, I do `other(this())` to seed `other` from `this`. This is asymmetric and arbitrary — why does `this` win? It works for the test I wrote but it's not principled. Real `mirror` would need a policy parameter, or it should refuse to sync until both sides have explicit values, or always raise on conflict.

_The `bind` clobber semantic._ `bind` installs an effect that writes `other`'s value into `this`. If you write `this(...)` directly while the bind is active, the next change of `other` clobbers your write. This is the worst of the three options for write semantics — I noted it in the report but didn't fix it. The right behavior is either "writes break the bind" or "writes are rejected while bound." Probably the former.

_The cell setter doing implicit bind/write dispatch._ `cell.x = sig` calls bind, `cell.x = 5` calls write. This is convenient sugar but means the _same JS syntax_ does fundamentally different things based on RHS type. A user who has a variable `v` and writes `cell.x = v` doesn't know at the call site whether v is a signal or a number. The fix: spell out the operation. `cell.x.follow(other)` for binding, `cell.x(5)` for writing. The `=` sugar is dangerous and should probably go.

_The lens (Form C) write semantics._ When the user writes `vL.x(99)`, the lens reads `wholeSig()`, spreads, writes back. Three ops, with one allocation per write. For ten writes you allocate ten objects. The previous "one signal, fields are lenses" pattern in your current code probably does this more efficiently. This is a real perf regression in my prototype's Form C compared to a hand-tuned implementation.

_The `valueSpec` typing._ The config uses `value: T | (() => Record<...>)`. The TypeScript inference for `T` from a literal like `{ x: 0, y: 0 }` gives `{ x: number, y: number }`, but for `{ translate: Vec, ... }` it gives `{ translate: TypeProto<any>, ... }` not `{ translate: V, ... }`. ExtractT needs to walk and substitute. This is unfinished — I didn't push hard on inference completeness and the result is that user-side typing of structs with typed fields is going to be poor without more work.

_The casts in tests._ I used `(v as any)` in several places. Some of these reflect real inference gaps (above); some are laziness. A complete inference story would eliminate all the casts.

_Primitive proto sharing._ `NumProto`, `StrProto`, `BoolProto` are module-level singletons. This means any user who registers a custom Num-like type and tries to use it where a primitive is expected hits the singleton. There's an implicit assumption that all "numbers" share traits. Probably fine but worth noting — the primitive protos are not user-extensible.

_The mixing of cell and signal in the API._ `signal(0)` returns a Cell. `Vec({x:0,y:0})` returns a Cell. They use the same `Cell` type. But raw signals don't have `traits.linear` for everyone — they have it only for primitive types. So the surface advertised by `Cell<T>` is a lie in some cases. This is a real type-soundness problem.

_Function constructor for prototypes._ `const proto: any = function Cell(initial?: any) {...}`. The function is the prototype AND the factory. Cells use it as both. This works but makes some operations weird: `Vec.bind` (which would call Function.prototype.bind on the Vec function itself) is shadowed by the proto.bind which is meant for cells. This is the bind/follow rename addressing some of it, but there's still confusion between "this prototype as a function" and "this prototype as a type record."

A cleaner separation: factory and prototype are different objects. `Vec.cell({x:1})` returns a cell whose prototype is `Vec.prototype` (a separate plain object, not a function). `Vec` itself is just a callable convenience wrapper around `Vec.cell`. This costs one indirection but cleanly separates the roles.

I'm not sure if that's worth it. Today's collapsed version (proto = function) is small and works. Worth flagging.

_The `proto.bind = function(this, other)` definition pattern._ The arrow vs function distinction matters because `this` has to be the cell, not the proto. The current code uses regular functions consistently for this reason. It works but is the kind of thing where a future contributor might convert to arrows for "cleanness" and break everything. A comment marker would help.

_The recursive composite walk._ `compositeLinear<T>(fields)` takes a runtime fields map and produces a linear impl. If the value has nested composite types (a Transform inside something else), each level walks its own fields. This works but the type system doesn't help — each level uses `any` casts. Could be made type-safe with more inference work.

_The `nested cell construction inside the factory._ When `value: { translate: Vec, ... }`, my code does `fields[k] = (entry as any)(init)` to construct a sub-cell. This calls the _type constructor function_ (Vec) which itself does the entire factory dance — creates a new alien signal, attaches a prototype, etc. For each parent cell construction, this recurses. Construction cost scales linearly with nesting depth. Fine for typical UI shapes, would matter for many-instance scenarios. Worth knowing.

_The `wholeWrite` for composites does partial-update._ `wholeWrite: (v) => { for k in keys: if k in v: fields[k](v[k]) }`. If the user passes `{x: 5}`, only x updates. If they pass `{x: 5, z: 9}`, z is silently ignored. Probably correct behavior (extra fields shouldn't be silent errors? or should be?). Currently silent. Could throw in strict mode.

_The `effect` return type from alien-signals._ It returns a dispose function. I pass that through directly. Fine.

_Performance of `cell()` aggregate read._ Walks every field, reads each, builds an object. For a Transform that's 4 reads + 1 object allocation per `t()` call. Not terrible but it's per-call, not memoized. If `t()` is called frequently in animation code, this allocates per frame. The fix: cache the aggregate as a computed cell that invalidates when any field changes. Adds one signal per struct cell but caches reads.

_General readability._ The cell construction function is ~80 lines doing four different things. Hard to follow on first read. Would benefit from being broken up into clearly-named per-form helpers.

**Where this leaves me**

The design is sound — I'd defend it. The prototype implementation has real warts that need work before it's good code. The biggest improvements I'd make:

1. Drop Form C entirely. Either always per-field signals, or `shared({...})` as an explicit lens-pack opt-in.
2. Drop Form D (scalar). Use `signal()` directly for primitives.
3. Add `ops` slot, function-form for `traits` that closes over ops.
4. Add `compose: ["lerp", "linear"]` for composite synthesis. Drop the helper functions as the primary API.
5. Rename `bind`/`mirror` to `follow`/`sync`.
6. Drop the `cell.x = signal` sugar — it's too implicit. Use `cell.x.follow(other)` explicitly.
7. Remove dead code (`delete cell.name`, `staticFieldNames`).
8. Add a `STRUCT_BRAND` symbol to make `isTypeProto`/`isCell` nominal.
9. Add a reserved-names util.
10. Investigate the alien-signals propagation issue from the previous round before committing to any lens pattern.

That's an honest pass. The prototype is a good shape, not yet good code.
