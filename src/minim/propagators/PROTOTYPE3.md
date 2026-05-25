# Propagators — third-pass: terse API + a real network() design question

Builds on `PROTOTYPE2.md`. This round focused on:
1. **Terse layout combinators** that don't expose individual `Num`s.
2. **A real design question about `network()`** — surfaced by the
   "touch all reads on every run" workaround from last round.

## TL;DR

1. **The `Box` + `hstack`/`vstack`/`grid`/`inset` API is dramatic.**
   8 declared signals → 3. Layout reads like prose.
2. **Composition is free** — nested layouts (e.g. app shell: window
   → padded content → 3 panes with `align: stretch`) are 3 lines.
3. **Performance holds** — hstack N=100 with bounds: 0.047 ms / drag,
   nested 10×10: 0.057 ms, grid 10×10: 0.021 ms.
4. **`network()` has a real design wart** — its purge-on-rerun model
   is right for fine-grained reactivity (effect/computed) but wrong
   for static-subscription network bodies. We worked around it
   (`_runFixpoint` touches all reads); a `static: true` opt or a
   sibling primitive would be the principled fix.

## The terse API: dramatic before/after

### Before: 8 declared signals, layout split across an opts object

```ts
const containerX = num(0);
const containerW = num(300);
const itemXs = [num(0), num(0), num(0)];
const itemWs = [num(80), num(80), num(80)];
const gap = num(8);

const p = propagators();
p.add(flexH({
  containerX,
  containerWidth: containerW,
  gap,
  items: [
    { x: itemXs[0]!, w: itemWs[0]! },
    { x: itemXs[1]!, w: itemWs[1]! },
    { x: itemXs[2]!, w: itemWs[2]! },
  ],
}));
```

### After: 3 declared signals (well, "boxes"), layout reads like prose

```ts
const c = box({ w: 300 });
const items = [box({ w: 80 }), box({ w: 80 }), box({ w: 80 })];

const p = propagators();
p.add(hstack(c, items, { gap: 8 }));
```

A `Box` is just `{ x, y, w, h }` — four `Num` signals in a struct.
No new value class, no field lenses, no metadata. Combinators
accept Boxes directly.

### Composition stays trivial

```ts
// App shell: window → padded content → 3 stretched panes.
const window = box({ w: 1024, h: 768 });
const content = box();
const panes = [box(), box(), box()];

p.add(inset(window, content, { padding: 24 }));
p.add(hstack(content, panes, { gap: 12, align: "stretch" }));

// Drag the window: panes reflow.
window.w.value = 1280;
```

Three propagators, three lines, full layered layout. Reads like
SwiftUI.

## What the new combinators do

| Combinator | What it does |
|---|---|
| `hstack(c, items, opts)` | Items distributed left→right, fit/hug, grow/shrink, align cross-axis |
| `vstack(c, items, opts)` | Same on the other axis |
| `grid(c, items, { cols, gap, padding })` | Regular 2D grid, equal cells |
| `inset(outer, inner, { padding })` | `inner` fills `outer` minus padding all sides |

`StackOpts`:
```ts
{
  gap?: number | Read<number>;          // reactive!
  padding?: number | Read<number>;
  minSize?: number | Read<number>;       // applies to all items
  maxSize?: number | Read<number>;
  mode?: "fit" | "hug";                  // container drives or items drive
  align?: "start" | "center" | "end" | "stretch";
}
```

Reactive opts are checked once per propagator fire; if you pass a
`Num` for `gap`, dragging it reflows the layout.

## Performance (post-fix, post-redesign)

```
hstack N=100 with bounds (drag container):     0.047 ms / drag tick
hstack N=1000 with bounds (drag container):    0.289 ms / drag tick
nested 10×10 (hstack of vstacks, stretch):     0.057 ms / drag tick
grid 10×10:                                    0.021 ms / drag tick
app shell (inset + hstack stretch, drag win):  0.0022 ms / drag tick
```

Slightly slower than flexH at N=1000 because the iterative bound-
resolution loop scales with N. For typical UI scales (10s–100s of
items), the cost is irrelevant.

## The `network()` design question

Surfaced last round when we discovered `Propagators._runFixpoint`
needed to "touch all reads on every run" to prevent subscriptions
from being purged. Worth thinking about more carefully.

### What the siblings do

| Primitive  | Subs come from         | Purge policy                   |
|-----------|------------------------|--------------------------------|
| `effect`  | what body read this run | purged + rebuilt every run     |
| `computed`| what body read this run | purged + rebuilt every run     |
| `network` | what body read this run | purged + rebuilt every run     |

All three use **fine-grained reactivity**: subs match exactly what
the last run read. That's correct for `effect` and `computed`
because:

- An `effect` is "do this side effect when these specific deps
  change" — if the body conditionally skips reading some signal,
  spurious re-runs would be wrong.
- A `computed` is "this is a derived value of these specific
  inputs" — same logic.

### Why it's wrong for `network()`

A propagator network is **a sub-DAG of stable relations**. The
network's subs should be the UNION of every relation's reads, not
"whatever fired this turn." Concrete failure mode:

1. Add adder #1 (reads `a1, b1, c1`) and adder #2 (reads `a2, b2, c2`).
2. First fire: body reads all six signals → all six in deps.
3. User writes `a1 = 80`. Network re-fires.
4. Body's `_runFixpoint` only runs adder #1 (its reads are fresh);
   adder #2 doesn't fire, its reads aren't touched.
5. After the run, `_NetworkNode._runBody` calls `purgeDeps()` and
   rebuilds `lastValues` from current deps. Only `a1, b1, c1` are
   in the new dep list.
6. User writes `b2 = 100`. Network has no sub on `b2`. Doesn't fire.
   **Adder #2 silently broken.**

This is exactly what the workaround prevents: by reading every
propagator's reads at the top of the body, we force them all into
the dep list every fire.

### What's the principled fix?

Three real options:

#### A. Add a `static: true` opt to `network()`

```ts
const n = network(body, { static: true });
// Once a signal is read, it stays subscribed until n.dispose().
// `purgeDeps` is skipped; `lastValues` is still updated for dirty.
```

Pros:
- Zero overhead in user code.
- Honest about the semantic difference.
- Matches what propagator networks (and probably most "sub-DAG"
  use cases) want.

Cons:
- Memory: signals conditionally read once stay subscribed forever.
- Two semantics for `network()` to document.

#### B. Add an explicit `track(...signals)` API on the handle

```ts
const n = network(body);
n.track(signal1, signal2);
// signal1, signal2 are static deps; never purged. body-time reads
// remain fine-grained.
```

Pros:
- Explicit; finest control.
- No memory leak risk from conditional reads.
- Hybrid: most subs fine-grained, a few stable.

Cons:
- More API surface.
- Propagator code needs to call `track()` for every read of every
  propagator — chatty.

#### C. New primitive: `staticNetwork(deps, body)`

```ts
const n = staticNetwork([sig1, sig2, ...], body);
// Subs are EXACTLY the deps array. Body's own reads don't add subs
// (or do, but they get persisted across runs).
```

Pros:
- Clearest separation between "fine-grained" and "static-subs"
  semantics.
- Up-front declaration of deps maps cleanly to the propagator-
  network model.

Cons:
- Adds a primitive.
- Doesn't compose well with body code that genuinely doesn't know
  its deps until run-time (rare in this pattern, but possible).

### My take

I'd ship **(A)** as a `static: true` opt on `network()`.

Reasoning:
- The current "touch all reads" workaround is a hack that pays per-
  fire cost AND is invisible to users authoring custom Propagator
  networks. Easy to forget, easy to reintroduce the bug.
- `staticNetwork()` is conceptually clean but doubles the primitive
  count for what's really one bit of behavior.
- `track()` is good for HYBRID networks (mostly fine-grained, some
  stable) — but I haven't seen a real use case for that yet.
- A `static: true` opt is small, principled, and matches the actual
  use pattern: when you build a relation graph, all its inputs are
  stable subs.

If `track()` becomes useful later, it can be added without
breaking `static`. If `staticNetwork()` becomes useful later, it
can be sugar over `network({ static: true })`.

### Why this isn't blocking

The current "touch all reads" workaround works. Tests are green.
Performance overhead is ~3% on benchmarks. Memory cost: zero — the
network's `_lastValues` is the same set as if we'd subscribed
statically.

Worth fixing for cleanliness; not worth blocking the prototype on.

## Other API directions worth probing

These would likely come AFTER promoting the prototype.

### Inline declaration

```ts
const layout = vstack({
  in: viewport,
  gap: 16,
  items: [
    hstack({ items: [tab1, tab2, tab3], gap: 8 }),
    body,
    footer,
  ],
});
```

Returns the propagators bundled with the boxes. Currently you wire
them separately. Bundling would feel more declarative.

### Box methods

```ts
const c = box({ w: 300 });
c.hstack([item1, item2, item3], { gap: 8 });   // attaches the propagator
```

Trade: adds methods to Box → Box is no longer a plain struct.
Probably worth it for ergonomics.

### Computed boxes

```ts
const b = boxFrom(centerX, centerY, w, h);
// b.x, b.y, b.w, b.h are derived from arbitrary signals.
```

Gives you reactive "this box always tracks this center point and
size" without needing to write each field. Good for UI element
descriptors.

### Constraint sugar

```ts
constrain(box1.right, box2.left, { offset: 8 });
// box1.right + 8 = box2.left
```

Edge-relative constraints. Easy to express, hard to compose with
flex. Probably belongs in a "Cassowary-style" sub-API rather than
flex-style.

## What I'd ship now

```
src/minim/propagators/
├── network.ts           ← the real bug fix lives here; design Q open
├── propagator.ts
├── combinators.ts       ← adder, eq, allDifferent, distributeH
├── range.ts             ← interval cells (inference)
├── layout.ts            ← flexH (full CSS-flex semantics)
├── stacks.ts            ← hstack, vstack, grid, inset (terse API)
├── box.ts               ← Box struct
├── index.ts
├── PROTOTYPE.md
├── PROTOTYPE2.md
├── PROTOTYPE3.md        ← this file
└── _test/               ← 73 + 15 = 88 tests passing
```

### Public API surface (recommended)

For 90% of layout work, users only need:

- `box(init)` — declare a spatial primitive.
- `propagators(opts)` — make a network.
- `hstack`, `vstack`, `grid`, `inset` — terse combinators.

For complex one-off relations:

- Custom `propagator(reads, writes, step)`.

For inference / set-narrowing:

- `intervalAdder`, `allDifferent`, `propagator` over `signal<Set<T>>`
  or `signal<[number, number]>`.

For raw bidirectional 2-way relations:

- `adder`, `eq`, `aspectRatio`, `align`.

That's a workably small surface for what the system can do.

## Recommendation for next round

1. **Fix the network() design**: either ship the `static: true` opt
   or document the workaround firmly. Without it, custom propagator
   networks have a quiet correctness footgun.
2. **Build a real demo** that exercises the terse API end-to-end:
   drag-resizable IDE-style layout with sidebar, editor, file tree,
   minimap. Validate that it feels as good as it reads.
3. **Promote `propagators/` to public API** with `box`, `hstack`,
   `vstack`, `grid`, `inset`, `propagator`, `propagators` as the
   first-class surface.
