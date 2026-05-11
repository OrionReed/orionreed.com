// Awaitable adapters and combinators. Each adapter returns an
// `Awaitable<T>` constructed via the `awaitable(...)` factory in anim,
// so `yield* aw` recovers the typed payload at the call site. Sync-
// resolve (calling `wake` before returning) is fine.

import {
  asGen,
  awaitable,
  isGen,
  type Awaitable,
  type AwaitableFn,
  type Yieldable,
} from "./anim";
import { effect, type ReadonlySignal } from "./signal";

// ── Adapters ────────────────────────────────────────────────────────

/** Wake on the next change of `sig`; the resume value is the new
 *  signal value. The baseline read is ignored. */
export function untilChange<T>(sig: ReadonlySignal<T>): Awaitable<T> {
  return awaitable<T>((wake) => {
    let first = true;
    return effect(() => {
      const v = sig.value;
      if (first) {
        first = false;
        return;
      }
      wake(v);
    });
  });
}

/** Wake when `sig` is truthy. Wakes immediately if already truthy. No
 *  payload — `true` is the only thing it would ever carry. For
 *  "becomes falsy," pass `sig.derive(v => !v)`. */
export function untilTrue(sig: ReadonlySignal<unknown>): Awaitable<void> {
  return awaitable((wake) => {
    let resolved = false;
    return effect(() => {
      if (resolved) return;
      if (sig.value) {
        resolved = true;
        wake();
      }
    });
  });
}

/** Wake on one DOM event; the event itself is the resume value.
 *  Listener auto-removes on fire or cancel. */
export function onceEvent(
  target: EventTarget,
  name: string,
  opts?: AddEventListenerOptions,
): Awaitable<Event> {
  return awaitable<Event>((wake) => {
    const handler = (e: Event): void => wake(e);
    target.addEventListener(name, handler, { ...opts, once: true });
    return () => target.removeEventListener(name, handler);
  });
}

/** Wake when `p` settles; the resolved value is the resume value.
 *  Cancel suppresses `wake` (the promise itself can't be cancelled). */
export function fromPromise<T>(p: Promise<T>): Awaitable<T> {
  return awaitable<T>((wake) => {
    let cancelled = false;
    p.then((v) => {
      if (!cancelled) wake(v);
    });
    return () => {
      cancelled = true;
    };
  });
}

// ── Combinators ─────────────────────────────────────────────────────

/** Extract the payload type from any `Yieldable`. Awaitables carry
 *  their `T`; everything else (gens, numbers, arrays, undefined) has
 *  no payload — modelled as `void` so unions stay 0-arg-callable. */
type PayloadOf<Y> = Y extends AwaitableFn<infer T> ? T : void;

/** First-completion race; the winning child's payload is the resume
 *  value. Children may be any `Yieldable` (generator, awaitable, number
 *  sleep, array parallel, `undefined` one frame). First to finish wakes
 *  the parent with its payload; the rest are cancelled. Generators,
 *  sleeps, and parallel arrays contribute `void` to the payload union —
 *  the winner being one of those resumes with `undefined`. */
export function race<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Awaitable<PayloadOf<Cs[number]>> {
  return awaitable<PayloadOf<Cs[number]>>((wake, spawn) => {
    type V = PayloadOf<Cs[number]>;
    let won = false;
    let setupDone = false;
    let pending = false;
    let pendingValue: V | undefined;
    // A sync-completing child during the spawn loop defers its wake
    // until all siblings are spawned, so cancel still reaches losers.
    const safeWake = (value?: V): void => {
      if (won) return;
      won = true;
      if (setupDone) (wake as (v?: V) => void)(value);
      else {
        pending = true;
        pendingValue = value;
      }
    };
    const disposers: (() => void)[] = [];
    for (const c of children) {
      if (typeof c === "function" && !isGen(c)) {
        // Bare AwaitableFn — subscribe directly, sharing our spawn so
        // nested combinators (race-of-races) work without rewrapping.
        disposers.push(
          (c as AwaitableFn<unknown>)(safeWake as (v: unknown) => void, spawn),
        );
      } else {
        // Gen / number / array / undefined — payload-less; safeWake
        // gets called with no args, V resolves to `undefined`.
        disposers.push(spawn(asGen(c), safeWake as () => void));
      }
    }
    setupDone = true;
    if (pending) (wake as (v?: V) => void)(pendingValue);
    return () => {
      for (const d of disposers) d();
    };
  });
}

/** Run `work` until `trigger` fires (cancel-on-trigger). Sugar over
 *  `race(work, trigger)`. The resume value is whichever side won —
 *  `work`'s payload if it completed naturally, `trigger`'s payload if
 *  it fired first. The next `yield*` after `yield until(...)` is the
 *  graceful-exit sequel. */
export function until<W extends Yieldable, T extends Yieldable>(
  trigger: T,
  work: W,
): Awaitable<PayloadOf<W> | PayloadOf<T>> {
  return race(work, trigger) as Awaitable<PayloadOf<W> | PayloadOf<T>>;
}
