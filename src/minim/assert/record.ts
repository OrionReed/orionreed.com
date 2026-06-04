// record(anim) — start collecting a live trace.
//
// Multiple recorders coexist: span listeners and the signal write hook
// fan out to all of them, each keeping its own list (two demos on one
// page get independent traces). The recorder owns the clock — it stamps
// `span.start` / `span.end` from its `anim.clock`; the engine is unaware.

import type { Anim } from "@minim/core";
import {
  derive,
  type Read,
  type Cell,
  setCellWriteHook,
  cell,
  type Writable,
} from "@minim/signals";
import { bumpTraceVersion } from "./scope";
import { addSpanListener, currentSpan, type Span } from "./span";

/** A live recording session. */
export interface Recorder {
  /** The bound anim; exposed so helpers (e.g. `firstOf`) read the clock. */
  readonly anim: Anim;
  /** Every span seen, in open-time order; re-runs subscribers on open/close. */
  readonly spans: Read<readonly Span[]>;
  /** Disengage hooks. Existing spans stay queryable; no new attribution. */
  stop(): void;
}

/** Active recorders; the write hook fans attribution out to all. */
const recorders = new Set<Recorder>();

/** Global write-hook disposer; installed on first recorder, removed on last. */
let removeWriteHook: (() => void) | undefined;

/** Per-signal "current writer", lazily created by `authorOf`. GC-safe via WeakMap. */
const writerOf = new WeakMap<Cell<unknown>, Writable<Cell<Span | undefined>>>();

/** Begin recording. Concurrent sessions each receive every span (filter
 *  by anim yourself). Stamps start/end from `anim.clock` on open/close. */
export function record(anim: Anim): Recorder {
  const list: Span[] = [];
  const ver = cell(0);

  const removeListener = addSpanListener(
    s => {
      s.start = anim.clock;
      list.push(s);
      ver.value++;
      bumpTraceVersion();
    },
    s => {
      s.end = anim.clock;
      ver.value++;
      bumpTraceVersion();
    },
  );

  // Install the write hook on first recorder; remove on last stop.
  if (recorders.size === 0) {
    removeWriteHook = setCellWriteHook(sig => {
      const s = currentSpan;
      if (s) s.touched.add(sig);
      const writer = writerOf.get(sig);
      if (writer) writer.value = s;
    });
  }

  const spansRead = derive(() => {
    ver.value;
    return list as readonly Span[];
  });

  const recorder: Recorder = {
    anim,
    spans: spansRead,
    stop() {
      if (!recorders.has(recorder)) return;
      recorders.delete(recorder);
      removeListener();
      if (recorders.size === 0 && removeWriteHook) {
        removeWriteHook();
        removeWriteHook = undefined;
      }
    },
  };
  recorders.add(recorder);
  return recorder;
}

/** Any active recorder, or undefined. */
export function activeRecorder(): Recorder | undefined {
  for (const r of recorders) return r;
  return undefined;
}

/** Most recent span that wrote to `sig`, or undefined. One memoized
 *  Cell per asked-about Cell. */
export function authorOf<T>(sig: Cell<T>): Read<Span | undefined> {
  let writer = writerOf.get(sig as Cell<unknown>);
  if (!writer) {
    writer = cell<Span | undefined>(undefined);
    writerOf.set(sig as Cell<unknown>, writer);
  }
  return writer;
}
