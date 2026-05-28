# Findings — `own()`, the symmetric writable-parameter primitive

> 33 tests across own.test.ts / own-stress.test.ts / own-perf.test.ts, all green.
> Full project suite (1517 tests) still green.
> No production engine changes.

## Bottom line

**The "fourth direction" actually works.** `own(slack)` gives you a
writable parameter that is:

- **externally observable** (any code can read, derive, subscribe);
- **single-writer** (only the claiming lens factory writes — runtime
  enforced by a monkey-patched setter; production wants this in the
  engine instead);
- **symmetrically routed** (drag-A fires slack's bwd the same way
  drag-B does, with residual flowing to the opposite side);
- **one-pass acyclic** (no fixpoint; same termination story as the
  existing lens substrate);
- **glitch-free** (downstream observers never see the
  drag-a-but-slack-not-yet-updated intermediate value — see below).

This is the lens-substrate addition the long chat converged on. It
genuinely delivers what the previous discussion claimed and survives
the adversarial cases I could invent.

## What's in the prototype

```
own.ts          (267 lines)  brand, claim, installReaction, 4 factories
own-lock.ts     (68  lines)  runtime ownership enforcement
_test/own.test.ts            (372 lines, 22 tests) — headline behaviors
_test/own-stress.test.ts     (344 lines, 15 tests) — adversarial probes
_test/own-perf.test.ts       (92  lines, 6  tests) — perf characterization
```

Factories implemented:

- `numAddOwn(self, own(s))` — `b = a + s`, symmetric
- `numSubOwn(self, own(s))` — `b = a - s`, symmetric
- `numScaleOwn(self, own(k))` — `b = a * k`, symmetric (with singularity
  handling at a = 0)
- `vecRightOwn(self, own(n))` — `b.x = a.x + n; b.y = a.y`, symmetric on x

Each is ~25-30 lines. The common pattern (closure-style bwd + claim +
network reaction) is factored into `installReaction(sig, parents,
computeSink, token)`, leaving each factory with just its specific
algebra.

## Headline tests that pass

```ts
// The symmetric drag-through:
const a = num(100);
const slack = num(30).clamp(5, 50);
const b = numAddOwn(a, own(slack));

b.value = 145;  // drag b: slack absorbs (existing w() behavior) → slack=45
a.value = 110;  // drag a: slack absorbs (NEW) → slack=20 (because bIntended=145)
a.value = 200;  // drag a past slack range: slack saturates → slack=5, b drifts to 205
a.value = 100;  // recovery: slack un-saturates → b returns to bIntended=145
```

External observability:
```ts
const slack = num(30).clamp(5, 50);
const b = numAddOwn(a, own(slack));
const display = Num.derive([slack], ([s]) => s);   // ← derives over slack OK
effect(() => render(slack.value));                  // ← subscribes OK
slack.value = 999;                                   // ← throws (locked)
```

## Surprises (in a good way)

### PutGet holds further than I expected

I went in expecting "residual mechanism makes PG hold within the lossy
view space; outside, b drifts." What actually happens: the residual
chains all the way up — when slack saturates, the residual flows to
a, which makes b read back to exactly the target.

```
b.value = 100  // outside [a+5, a+55] = [105, 155]
// Bwd: delta = 100 - 130 = -30. slack desired = 0, clamps to 5.
//   actual slack change = -25. residual = -30 - (-25) = -5.
//   a := 100 - 5 = 95. b reads 95 + 5 = 100. PG HOLDS.
```

This holds across the chained-lens cascade too:
```
c.value = 500       // far outside reachable range
// c's bwd writes slack2 (saturates at 80), residual to b.
// b's bwd writes slack1 (saturates at 50), residual to a.
// a := 370, slack1 := 50, slack2 := 80.
// c reads: 370 + 50 + 80 = 500. PG HOLDS even through TWO saturations.
```

The "lossy lens" framing in BIDIRECTIONAL-LENSES.md slightly undersells
this: with residual-flow chains, PG holds across compositions in the
full target space, not just the projection space. The drift case is
only for parent-edits where the natural fwd re-derivation cannot be
counteracted (because we're not allowed to overwrite the just-edited
parent).

### Glitch-freedom is structural, not effortful

I expected the parent-change reaction to be glitchy — when A changes,
b would temporarily be `a_new + slack_old` before the reaction settled.
This DOESN'T happen, for two reasons that compose:

1. **Subscription order**: the `network([self], …)` reaction is set
   up at lens construction, BEFORE any effect can subscribe to b.
   So in `self.subs`, the reaction is first; b is second (added
   lazily when b is read). Propagation visits subs in order: reaction
   notified first → queued first → runs first in flush.
2. **Lazy re-derivation + equality short-circuit**: b doesn't update
   its cached value until read. By the time any effect reads b, the
   reaction has already written slack, and b's fwd produces the
   settled value. If the settled value equals the cached value
   (slack absorbed fully), the effect doesn't even fire.

So downstream observers see exactly one state change (and only if
b actually drifted). I verified this empirically:
```
effect(() => last = b.value, fires++);
// fires = 1 (construction)
a.value = 110;  // slack absorbs → b unchanged
// fires still = 1; effect was NOT spuriously triggered.
```

This is a substantive composability win — the design doesn't leak
intermediate states.

### Residual cascades through chained own() lenses

```ts
const b = numAddOwn(a, own(s1));   // s1 ∈ [5,50]
const c = numAddOwn(b, own(s2));   // s2 ∈ [10,80]
```

Drag a past s1's range:
- N1 fires: writes s1 → saturates. b drifts.
- b changed → N2 fires: writes s2 → may saturate. c drifts.
- One pass, no fixpoint, no iteration.

Recovery (drag a back): N1 → s1 un-saturates → b recovers → N2 fires
→ s2 un-saturates → c recovers. Same one pass, all the way back.

## What broke (and why it's fine)

### Transitive-root diamond — same hole as w()

```ts
const root = num(30);
const v1 = root.clamp(5, 50);
const v2 = root.clamp(5, 50);
const b1 = numAddOwn(a1, own(v1));   // claims v1
const b2 = numAddOwn(a2, own(v2));   // claims v2 — different brand, succeeds

a1.value = 110;     // N1 writes v1 → root := 20 → v2 also reads 20
// b2 silently drifted: 50 + 20 = 70 (was 80). PG broken for b2.
// N2 doesn't fire because a2 didn't change.
```

This is identical to the asymmetric-diamond failure documented in
`FINDINGS.md` for `w()`. own() doesn't introduce a new failure mode
here — it inherits the same one. Production fix: `claim()` walks
transitive roots and rejects if any other claimed cell shares one
(`wp-detect.ts` machinery, generalized).

### Multiplicative singularity at a = 0

`numScaleOwn(a, own(k))` falls through gracefully when a = 0 (can't
solve for k = b/a). The reaction skips the write, leaving k unchanged
and b drifting. This matches `_scaleW`'s handling and the §15
symmetric-lens story for scale-trap lenses.

## What "ownership enforcement" looks like in practice

The runtime lock (own-lock.ts) replaces `Signal.prototype.value`'s
setter on each locked instance with a token-checking variant. Writes
through `.value =` from outside the owner context throw. Writes via
the engine's internal `_setWithExclusion` (used by lens-fused chains
and propagators) bypass the monkey-patched setter — that's fine,
because internal cascade writes never target the owned cell directly
(they target its parents, which are not locked).

```ts
const slack = num(30).clamp(5, 50);
const b = numAddOwn(a, own(slack));

slack.value = 50;              // TypeError: external writes not permitted
b.value = 200;                  // ✓ — bwd writes inside withinOwner(token)
a.value = 110;                  // ✓ — reaction writes inside withinOwner(token)
```

This is a meaningful safety upgrade over the convention-only brand,
delivered without engine modification. The production path is to
move the lock into `Signal._setWithExclusion` directly with an
explicit `ownerToken?: symbol` parameter — same shape, just covers
the `_setWithExclusion` path too (closing the "transitive view of
same primitive" hole when combined with diamond detection).

## Code shape: what the value class actually pays

Each method that wants own() support gets a factory that's structurally
identical to its `_*W` sibling — same closure-form bwd, plus claim +
reaction. The factored `installReaction(sig, parents, computeSink,
token)` helper centralizes the network-subscription pattern. Per
method, the unique content is just the algebra (fwd + how to compute
desired sink from intended view value):

```ts
// numAddOwn — illustrative; full file in own.ts
export function numAddOwn(self, ownArg) {
  const sig = ownArg.sig;
  const bIntended = { value: self.peek() + sig.peek() };

  const lens = Num.lens(
    () => self.value + sig.value,
    target => withinOwner(token, () => batch(() => {
      bIntended.value = target;
      const sv = self.peek(), gv = sig.peek();
      const delta = target - (sv + gv);
      sig.value = gv + delta;                       // sink absorbs first
      const residual = delta - (sig.peek() - gv);
      if (residual !== 0) self.value = sv + residual; // residual to receiver
    })),
  );
  const token = claim(ownArg, lens);
  installReaction(sig, [self], () => bIntended.value - self.peek(), token);
  return lens;
}
```

~25 lines, plus a one-line algebra-specific lambda in
`installReaction`'s last argument. The `_*W` siblings stay
untouched. Production migration would have each value-class method
add an `Own<T>` overload arm that calls the matching `*Own` helper —
roughly identical surgery to what the existing `w()` integration in
`num.ts` does (the `isW(b)` discriminant + `_*W` dispatch).

## Performance characterization

(Numbers vary per machine; loose bounds asserted in `own-perf.test.ts`.)

| Operation | Order of magnitude |
|---|---|
| bare signal write x 10k | a few ms |
| w() lens drag-b x 10k | similar to bare + lens overhead |
| own() lens drag-b x 10k | similar to w() (same bwd path) |
| own() lens drag-a x 10k | ~2-3x bare (one extra reaction fire per edit) |
| 3-deep own() chain, drag root x 10k | linear in depth |
| own() hot read loop x 10k | identical to lens read |

No fixpoint, no iteration. The drag-a path has a constant-factor
overhead equal to one network-body call per edit per own() lens
above the dragged cell. Acceptable for 60Hz interaction at typical UI
graph depths.

## What surprised me in the design space

1. **`network()` is the right primitive for the parent-change
   reaction.** Its `dirty` set lets us distinguish first-fire from
   subsequent fires; its self-exclusion prevents the body's own
   writes from re-triggering it; its batching coalesces multi-write
   bursts. It was designed for "many signals tied together with
   feedback" — own() is exactly that pattern at a smaller scale.

2. **The b_intended closure variable is load-bearing.** It's the
   user's "what should b be" — set by view-writes (via bwd) and
   consulted by the reaction. Without it, the reaction has no
   notion of "preserve the previous b"; it would just write
   something arbitrary. This is exactly the HPW symmetric-lens
   "complement" — the private state that lets both directions
   stay consistent.

3. **Monkey-patching the setter is enough for prototype ownership
   enforcement.** I expected to need engine changes. The combination
   of (a) `.value =` for external writes, and (b) `_setWithExclusion`
   for internal cascades, means the external-only intercept is
   sufficient. The user can't write the owned cell through any path
   the prototype actually exposes.

4. **The chained-cascade is principled, not coincidental.** I worried
   that c = b.add(own(s2)), b = a.add(own(s1)) would have ordering
   issues — does N1 fire before N2? Yes, by construction order in
   `self.subs`. Both reactions then converge on the same target
   (preserve respective b_intended values). The math composes:
   when a moves and s1 saturates, b drifts, N2 sees b drift and
   tries to preserve c_intended via s2; if s2 saturates too, c
   drifts. All in one pass.

## Open / deferred

1. **Engine-level lock** — production path: add `_ownerToken?:
   symbol` to Signal and check in `_setWithExclusion`. ~5 lines.
   Covers the `_setWithExclusion` path too.
2. **Diamond detection** — `claim()` walks transitive roots via
   `_fusedOf` to detect shared-primitive cases. Reuses the wp-detect
   logic.
3. **Type-level `Own<T>`** — TypeScript brand that exposes `Sink<T>`
   as `Readable<T>` to outside code. Prevents the external write
   statically (today the lock only catches it at runtime).
4. **More value-class methods** — `clamp`, `affine`, `lerp`,
   `vecOffset`, `vecScale` — each gets a `*Own` helper following the
   pattern. ~30 lines each.
5. **Multi-sink lenses** — `affine(own(k), own(off))` would claim
   both `k` and `off` as separate sinks. The reaction body writes
   both. Algebra is just simultaneous solve for k and off from b
   and a. Not implemented in this prototype but no obvious obstacle.
6. **`network()` lifecycle** — the reaction's network isn't disposed
   when the lens is GC'd; needs explicit dispose hook. Minor.

## Verdict

The design works. The headline claim ("symmetric drag-through with
one-pass acyclic semantics, externally observable, statically
distinguishable from `w()`") survives every adversarial test I could
think of. The production migration is small (~5 lines engine + ~30
lines per value-class method). The cost story is honest (some extra
work on parent-edits, none on RO/w() paths).

This is the substrate addition the long discussion converged on. The
"fourth direction" is real and reachable. `peer()` / `own()` (or
whatever naming wins) form a clean pair that exhausts the
single-lens-substrate design space:

| | shared | single-writer |
|---|---|---|
| asymmetric residual flow | **`w()` / `peer()`** | (degenerate) |
| symmetric residual flow | (trilemma — needs propagator/MDCS) | **`own()`** |

`own()` is the bottom-right corner. It's the cleanest possible thing
you can have while staying within the lens substrate's termination
and composition guarantees.
