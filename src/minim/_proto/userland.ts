// Everything previously baked into the engine, now plain userland.
// `scaled`, `detach`, `pauseWhen`, `slowmoWhen`, `pauseOnHidden`, `trace`.
//
// Each is 3-15 lines. Composing them is just stacking — the engine doesn't
// know what they do, only that they're transducers or suspends.

import {
  transduce,
  type Animator,
  type Transduced,
  type Transducer,
  type Yieldable,
} from "./engine";

// ───────────────────────────── Time transducers ──────────────────────────

/** Run `target` with `rate()` as its time-scale. Descendants inherit
 *  automatically (engine carries trans down the spawn chain).
 *  `rate() === 0` freezes the subtree (no localClock advance, no wake). */
export function scaled<R>(
  rate: () => number,
  target: Animator<R> | Transduced,
): Transduced {
  return transduce({ onTick: (dt) => dt * rate() }, target);
}

/** Pause the subtree while `pred()` is true. Equivalent to scaled(0|1). */
export function pauseWhen<R>(
  pred: () => boolean,
  target: Animator<R> | Transduced,
): Transduced {
  return scaled(() => (pred() ? 0 : 1), target);
}

/** Run the subtree at `fraction` speed while `pred()` is true; full speed otherwise. */
export function slowmoWhen<R>(
  pred: () => boolean,
  fraction: number,
  target: Animator<R> | Transduced,
): Transduced {
  return scaled(() => (pred() ? fraction : 1), target);
}

/** Pause subtree when the document is hidden (tab backgrounded / minimized). */
export function pauseOnHidden<R>(
  target: Animator<R> | Transduced,
): Transduced {
  return pauseWhen(
    () => typeof document !== "undefined" && document.hidden,
    target,
  );
}

// ─────────────────────────── Protocol transducers ────────────────────────

/** Log every yield and wake. Useful for debugging; pay only for what's traced. */
export function trace<R>(
  tag: string,
  target: Animator<R> | Transduced,
  log: (msg: string) => void = console.log,
): Transduced {
  const trans: Transducer = {
    onYield: (v) => {
      log(`[${tag}] yield ${describeYield(v)}`);
      return undefined;
    },
    onResume: (t) => {
      log(`[${tag}] resume dt=${t.dt.toFixed(4)} elapsed=${t.elapsed.toFixed(4)}`);
      return undefined;
    },
  };
  return transduce(trans, target);
}

function describeYield(v: Yieldable): string {
  if (v === undefined) return "park";
  if (typeof v === "number") return `sleep(${v})`;
  if (typeof v === "function") return "suspend";
  if (Array.isArray(v)) return `concurrent[${v.length}]`;
  if (typeof v === "object" && v !== null) {
    if ((v as Animator).next) return "child";
    return "transduced";
  }
  return String(v);
}

// ─────────────────────────── Spawn coordinators ──────────────────────────

/** Spawn `g` at engine root, resume parent immediately. Detached child
 *  outlives the spawning parent (survives parent cancel; dies on engine.stop()). */
export function* detach<R>(g: Animator<R>): Animator<void> {
  yield (wake, spawn) => {
    spawn(g);
    wake();
  };
}
