# Callable signal prototype

Going back to alien-signals' core architecture (function-bound signals)
and layering minim's chainable ops + trait slots on top.

## Hypothesis

Class-based `.value` API is what limits minim to preact-signals speed
(~10ns reads, ~10ns writes). alien-signals achieves <1ns reads/writes
because V8 inlines the callable's body at the call site, not just the
property lookup.

If we adopt the callable API for the engine AND attach methods/traits
to the bound function, can we get alien-signals' raw perf while keeping
`vec.add(b)` chaining and `vec[LERP]` trait access?

## What changes

API:
- `s.value` → `s()` (read)
- `s.value = x` → `s(x)` (write)
- `vec.add(b)` — stays (method on the callable)
- `vec.x` — stays (sub-signal exposed as property on callable)
- `vec[LINEAR]` — stays (trait symbol on the callable)
- `vec instanceof Vec` — REPLACED with `isVec(vec)` (callables can't extend classes)

This is a BREAKING change. Every `.value` in the codebase becomes `()`.

## Files

- `signal.ts` — function-bound primitives (uses alien-signals under the hood)
- `vec.ts` — callable Vec with methods + traits attached
- `bench.ts` — vs alien-signals raw, current minim, merged Reactive, preact

## Key V8 question

Does attaching methods via `Object.defineProperties` to a bound function
break V8's inlining of the callable? Bench will tell us.
