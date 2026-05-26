# Propagators

The solver-role layer in minim's reactive substrate. Where lenses
*define* values (`c = a.add(b)` IS the relation, by construction),
propagators *impose* relations between cells that already have their
own identity — UI handles, animation targets, externally-driven
signals, anything you need to **constrain** rather than **derive**.

## Layering

```
network()            ← reactive primitive (../signals/signal.ts)
   ↓
Propagators class    ← holds N propagators; one fixpoint loop per
                       body fire, with AUTO-EXPAND of lens-chain
                       parents and a fuel-capped iteration count.
   ↓
Combinators          ← in this folder (relations.ts, layout.ts, range.ts)
```

Three traits make this work:

- **Non-coloring** — propagators don't introduce a new signal type.
  `Writable<Num>`, `Writable<Vec>`, lensed signals, set cells, range
  cells all pass in directly.
- **AUTO-EXPAND** — declared reads are expanded transitively at install
  time via `transitiveDeps()` (in `signals/introspect.ts`), so a
  propagator that reads a lens chain's value also subscribes to the
  chain's parents. No silent freshness gaps.
- **Termination** — fuel-capped fixpoint plus monotone-narrowing for
  lattice cells. The system can't silently freeze; it either
  converges or throws `PropagatorDivergedError` with the still-
  changing signals named.

## File layout

```
propagators/
├── network.ts          Propagators class + fixpoint + AUTO-EXPAND
├── propagator.ts       Propagator interface
├── relations.ts        arithmetic + universal + geometric + set narrowing
├── layout.ts           Box-relational layout (hstack, grid, attach, …)
├── range.ts            interval cells (partial-info propagation)
├── box.ts              Box value-type re-export + `box()` factory
└── _probes/            semantic exploration + footgun catalog (see SEMANTICS.md)
```

## Combinator surface

### Arithmetic (trait-dispatched on `Linear<T>`)

- `add(a, b, c)` — Num, Vec, anything Linear. Three propagators.
- `sub(a, b, c)`
- `mid(a, b, m)` — midpoint; drag m → both endpoints translate.
- `centroid(c, ...vs)` — N-input centroid; drag c → all vs translate.

### Scalar-only

- `mul(a, b, c)` — division-by-zero skips the inverse direction.
- `aspectRatio(a, b, k)` — `a / b = k`.
- `sum([parts], total)` — N-way; any one part can be the unknown.

### Universal (any value type)

- `eq(a, b)` — bidirectional equality.
- `constant(s, v)` — pin to a fixed value.
- `align(...cells)` — variadic mutual equality (drag any → others
  follow).

### Geometric (Vec)

- `between(a, b, t, p, freeze?)` — point at parameter t along
  segment.
- `keepDistance(a, b, d)` — rigid bond. `d` can be Num signal.
- `onLine(p, a, b)` — project p onto line through a, b.
- `onCircle(p, c, r)` — snap p to circle around c.
- `reflect(src, a, b, dst)` — reflect across line.

### Set narrowing

- `allDifferent(...cells)` — singleton elimination across cells.

### Layout (Box-based)

- `hstack(c, items, opts?)` — CSS-flex-shaped horizontal layout.
  Items are `Box | { box, grow?, shrink?, min?, max? }`.
- `vstack(c, items, opts?)` — vertical version.
- `grid(c, items, { cols, gap?, gapX?, gapY?, padding? })`.
- `inset(outer, inner, { padding })` — inner fills outer minus pad.
- `attach(a, b, aSide, bSide, { gap })` — edge-to-edge anchor.
- `centerInside(outer, inner)` — center inner in outer.
- `pinEdge(b, side, target)` — pin one edge; opposite stays put.
- `lockSize(b, axis, value)` — fix a dimension.
- `follow(leader, follower)` — one-way mirror.

### Interval cells (partial-info propagation)

In `range.ts`. A `Range = [lo, hi]` cell. Operations narrow via
intersection (lattice meet); propagators are order-independent.

- `rangeCell(lo, hi)` — make an interval cell.
- `intervalAdder(a, b, c)`, `intervalSub`, `intervalSum`.
- `intervalEq(a, b)`, `constrain(cell, lo, hi)`.
- `snap(rangeCell, exactNum)` — interop with exact-value cells.

## When to reach for what

| Want | Tool |
|---|---|
| New cell that's a function of others | **Lens** (`a.add(b)`, `centroidLens(...)`) |
| Constrain pre-existing cells | **Propagator** |
| Cloth / soft-body / rigid-body physics | **`world()`** (AVBD) |
| Multi-output relation (`a + b = c + d`) | **Propagator** |
| Set / interval narrowing | **Propagator** |
| Layout (1D / 2D / nested) | **Propagator** (`hstack`/`grid`/etc.) |

For the deeper semantic story (definition / predicate / solver as
three independently-swappable concerns), see `_probes/SEMANTICS.md`.

## Performance reference

```
hstack N=100 with bounds (drag container):  0.03 ms / drag tick
hstack N=1000 with bounds:                  0.14 ms / drag tick
align N=100 (one→all):                      0.40 ms / drag tick
sudoku 4×4 install + solve:                 0.20 ms / trial
sudoku 9×9 install + solve (easy puzzle):   0.55 ms / trial
add chain N=100, drag head:                 0.10 ms / drag tick
1000-cell add chain install:                ~50 ms total
```

Competitive with native layout engines for typical UI scales.
Numbers are machine-specific; assertions in tests are loose.

## Footguns (the short list)

The full catalog is in `_probes/footgun-catalog.test.ts`. The two
that bite hardest:

1. **Bidirectional propagators (`add`, `eq`, `aspectRatio`) overwrite
   on initial fire.** If you have meaningful initial values, set them
   AFTER `p.add(...)` so the network learns the direction.
2. **Inconsistent cycles** through a lens chain throw
   `PropagatorDivergedError` (used to silently lie). Avoid such
   cycles, or use AVBD's iterative solve instead.

The rest (multiple writers per lens, hot-loop re-peeks, disposal
scope, lens-bwd surprise, boundary cells outside the network) are
predictable consequences of the model.

## Open / deferred

- Term reactive params on AVBD are tracked manually per-factory via
  `cluster._trackParam(sig)`. A future cleanup could move this onto
  Term.params for safety.
- Disjoint-network auto-partitioning would give ~3× perf on chain-
  shaped workloads. Probed; not implemented.
- `relate(target, lens-chain)` as a sugar combinator that converts
  a lens chain into a propagator. Probed; not in production.
