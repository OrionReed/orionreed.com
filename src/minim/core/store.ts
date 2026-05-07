// `store({...})` — a record of signals fronted by a Proxy so reads and
// writes look like plain property access (tracked inside reactive
// scopes, untracked outside). `snapshot(...)` captures current values
// of any mix of signals and stores and returns a reset function.

import { signal, Signal } from "./signal";

/** Runtime marker on store proxies; used by `snapshot` to detect
 *  stores and harvest their underlying signals. */
const STORE_SIGNALS: unique symbol = Symbol("minim.store");

/** Phantom type-level brand for distinguishing `Store<T>` from plain `T`. */
declare const STORE_BRAND: unique symbol;

export type Store<T extends object> = T & {
  readonly [STORE_BRAND]: never;
};

/** A reactive record. Each property is backed by a `Signal`; reads
 *  inside reactive scopes (computed/effect) track changes, writes
 *  notify subscribers. Outside reactive scopes, reads are untracked
 *  (no `.peek()` ceremony needed).
 *
 *      const state = store({ pendingA: 0, pendingB: 0, holding: false });
 *      state.pendingA++;            // writes signal
 *      computed(() => state.pendingA > 0);  // tracked
 *      const reset = snapshot(state);       // works on whole store
 */
export function store<T extends object>(initial: T): Store<T> {
  const sigs = {} as { [K in keyof T]: Signal<T[K]> };
  for (const key of Object.keys(initial) as Array<keyof T>) {
    sigs[key] = signal(initial[key]) as Signal<T[keyof T]>;
  }
  const proxy = new Proxy({} as object, {
    get(_, key) {
      if (key === STORE_SIGNALS) return sigs;
      const k = key as keyof T;
      return k in sigs ? sigs[k].value : undefined;
    },
    set(_, key, value) {
      const k = key as keyof T;
      if (!(k in sigs)) return false;
      (sigs[k] as Signal<unknown>).value = value;
      return true;
    },
    has(_, key) {
      return key === STORE_SIGNALS || (key as keyof T) in sigs;
    },
    ownKeys() {
      return Object.keys(sigs);
    },
    getOwnPropertyDescriptor(_, key) {
      return (key as keyof T) in sigs
        ? { enumerable: true, configurable: true, writable: true, value: undefined }
        : undefined;
    },
  });
  return proxy as Store<T>;
}

/** Capture the current values of `args` and return a function that
 *  restores them. Each arg is either a single `Signal` or a `Store`
 *  (whose fields are flattened to their underlying signals). Useful
 *  at the top of `anim.loop` bodies that mutate state, so each
 *  iteration starts from a known baseline:
 *
 *      const reset = snapshot(state, taps);
 *      this.anim.loop(function* () {
 *        reset();
 *        // ...
 *      });
 */
export function snapshot(
  ...args: ReadonlyArray<Signal<unknown> | Store<object>>
): () => void {
  const sigs: Signal<unknown>[] = [];
  for (const arg of args) {
    if (arg instanceof Signal) {
      sigs.push(arg);
      continue;
    }
    const inner = (arg as { [STORE_SIGNALS]?: Record<string, Signal<unknown>> })[
      STORE_SIGNALS
    ];
    if (inner) {
      for (const sig of Object.values(inner)) sigs.push(sig);
    }
  }
  const initials = sigs.map((s) => s.peek());
  return () => {
    for (let i = 0; i < sigs.length; i++) sigs[i].value = initials[i];
  };
}
