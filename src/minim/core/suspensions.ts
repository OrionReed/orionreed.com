// Suspension adapters and combinators. Each adapter returns the
// `Animator<R>` that `suspend<R>(impl)` produces — flat wrappers, not
// `function*`. `yield* aw(...)` resumes with the typed payload:
//
//     const evt = yield* onceEvent(el, "click");   // Event
//     const v   = yield* untilChange(sig);         // T (sig's new value)
//
// Sync-resolve (calling `wake` before returning) is fine.

import {
  asGen,
  isGen,
  suspend,
  type Animator,
  type SpawnFn,
  type Yieldable,
} from "./anim";
import { effect, type ReadonlySignal } from "./signal";

// ── Adapters ────────────────────────────────────────────────────────

/** Wake on the next change of `sig`; resume with the new value. The
 *  baseline read is ignored. */
export function untilChange<T>(sig: ReadonlySignal<T>): Animator<T> {
  return suspend<T>((wake) => {
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
export function untilTrue(sig: ReadonlySignal<unknown>): Animator<void> {
  return suspend<void>((wake) => {
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

/** Wake on one DOM event; resume with the event. Listener auto-removes
 *  on fire or cancel. */
export function onceEvent(
  target: EventTarget,
  name: string,
  opts?: AddEventListenerOptions,
): Animator<Event> {
  return suspend<Event>((wake) => {
    const handler = (e: Event): void => wake(e);
    target.addEventListener(name, handler, { ...opts, once: true });
    return () => target.removeEventListener(name, handler);
  });
}

/** Wake when `p` settles; resume with the resolved value. Cancel
 *  suppresses `wake` (the promise itself can't be cancelled). */
export function fromPromise<T>(p: Promise<T>): Animator<T> {
  return suspend<T>((wake) => {
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

/** Extract the payload type from a `Yieldable`. Generators carry their
 *  return value in `R`; everything else (numbers, arrays, raw suspend-fn
 *  lambdas, `undefined`) is `void`. For a typed payload from a custom
 *  impl, wrap it in `suspend<T>()` so it returns `Animator<T>`. */
type PayloadOf<Y> = Y extends Generator<any, infer R, any> ? R : void;

/** First-completion race; resume with the winning child's payload.
 *  Children may be any `Yieldable` (generator, raw suspend-fn, number
 *  sleep, array parallel, `undefined` one frame). First to finish
 *  wakes the parent with its payload; the rest are cancelled. Non-gen
 *  children (numbers, parallels, raw suspend-fn lambdas) contribute
 *  `void` to the payload union — when one wins, the resume value is
 *  `undefined`. Wrap a raw impl in `suspend<T>()` to flow its payload. */
export function race<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Animator<PayloadOf<Cs[number]>> {
  return suspend<PayloadOf<Cs[number]>>((wake, spawn) => {
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
        // Bare suspend-fn — subscribe directly, sharing our spawn so
        // nested combinators (race-of-races) work without rewrapping.
        disposers.push(
          (
            c as (
              wake: (v: unknown) => void,
              spawn: SpawnFn,
            ) => () => void
          )(safeWake as (v: unknown) => void, spawn),
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
 *  `race(work, trigger)`. Resume value is whichever side won. The next
 *  `yield*` after `yield until(...)` is the graceful-exit sequel. */
export function until<W extends Yieldable, T extends Yieldable>(
  trigger: T,
  work: W,
): Animator<PayloadOf<W> | PayloadOf<T>> {
  return race(work, trigger) as Animator<PayloadOf<W> | PayloadOf<T>>;
}
