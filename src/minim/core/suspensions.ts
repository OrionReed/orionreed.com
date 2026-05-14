// Suspension adapters and combinators. Adapters bridge an external
// source (signal change, DOM event, promise) to the suspend protocol
// — `yield* untilX(...)` resumes with the typed payload. Combinators
// orchestrate child Yieldables (race, endOn, startOn).
//
//     const evt = yield* untilEvent(el, "click");  // Event
//     const v   = yield* untilChange(sig);         // T (sig's new value)
//
// Sync-resolve (calling `wake` before returning) is fine.
//
// Naming: every `until*` adapter waits for *one* X to happen and then
// proceeds. Combinators read as temporal prepositions over work:
// `endOn(trigger, work)` ends work on trigger; `startOn(trigger, work)`
// starts work on trigger. The pair makes the temporal switch-point
// explicit.

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
 *  payload — `true` is the only thing it would ever carry. */
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

/** Wake when `sig` is falsy. Wakes immediately if already falsy.
 *  Complement of `untilTrue`. */
export function untilFalse(sig: ReadonlySignal<unknown>): Animator<void> {
  return suspend<void>((wake) => {
    let resolved = false;
    return effect(() => {
      if (resolved) return;
      if (!sig.value) {
        resolved = true;
        wake();
      }
    });
  });
}

/** Wake on one DOM event; resume with the event. Listener auto-removes
 *  on fire or cancel. */
export function untilEvent(
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
export function untilPromise<T>(p: Promise<T>): Animator<T> {
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
 *  wakes the parent with its payload; the rest are cancelled. */
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
        // Generator child — spawn forwards its return-value through
        // onComplete, so the winner's typed payload flows up.
        disposers.push(spawn(asGen(c), safeWake as (v: unknown) => void));
      }
    }
    setupDone = true;
    if (pending) (wake as (v?: V) => void)(pendingValue);
    return () => {
      for (const d of disposers) d();
    };
  });
}

/** Run `work` until `trigger` fires (cancel-on-trigger). The next
 *  `yield*` after `yield endOn(...)` is the graceful-exit sequel.
 *  Read: "this work ends on the trigger".
 *
 *      yield endOn(untilChange(stop), oscillate(y, 20, 1));
 *      yield* fadeOut(s, 0.4);                              // sequel */
export function endOn<W extends Yieldable, T extends Yieldable>(
  trigger: T,
  work: W,
): Animator<PayloadOf<W> | PayloadOf<T>> {
  return race(work, trigger) as Animator<PayloadOf<W> | PayloadOf<T>>;
}

/** Wait for `trigger`, then run `work`. The temporal complement of
 *  `endOn`. Read: "this work starts on the trigger". */
export function* startOn<W extends Yieldable, T extends Yieldable>(
  trigger: T,
  work: W,
): Animator<PayloadOf<W>> {
  yield trigger;
  if (isGen(work)) {
    return (yield* work) as PayloadOf<W>;
  }
  yield work;
  return undefined as PayloadOf<W>;
}
