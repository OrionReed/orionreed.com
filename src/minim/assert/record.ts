// record(anim) — start collecting a live trace.
//
// Multiple `record()` calls coexist: span-lifecycle listeners and the
// signal write hook fan out to all registered recorders. Each recorder
// keeps its own list (so two demos on one page each get their own
// trace, even though spans flow through a shared module-level pipe).
//
// The recorder owns the clock. When it receives an open/close event
// it stamps `span.start` / `span.end` from its own `anim.clock`. The
// engine itself is unaware of this package.

import type { Anim } from "@minim/core";
import {
  computed,
  type Read,
  type Signal,
  setSignalWriteHook,
  signal,
  type Writable,
} from "@minim/signals";
import { bumpTraceVersion } from "./scope";
import { addSpanListener, currentSpan, type Span } from "./span";

/** A live recording session. */
export interface Recorder {
  /** The anim this recorder is bound to. Exposed so users (and
   *  cross-cutting helpers like `firstOf`) can read the simulation
   *  clock without a global. */
  readonly anim: Anim;
  /** Read-only snapshot of every span this session has seen, in
   *  open-time order. Subscribed effects re-run on each open/close. */
  readonly spans: Read<readonly Span[]>;
  /** Disengage hooks. Existing spans remain queryable; no further
   *  spans are stamped or attributed to this recorder. */
  stop(): void;
}

/** All currently-active recorders. Used by the global write hook to
 *  fan out attribution. Also returned via `activeRecorder()` to give
 *  consumers a default. */
const recorders = new Set<Recorder>();

/** The single global write-hook disposer; installed when the first
 *  recorder starts, removed when the last one stops. */
let removeWriteHook: (() => void) | undefined;

/** Per-signal "current writer" registry. Each Signal that anyone asks
 *  `authorOf` about gets a `Signal<Span | undefined>` that's bumped on
 *  every attributed write. WeakMap keeps it GC-safe. */
const writerOf = new WeakMap<Signal<unknown>, Writable<Signal<Span | undefined>>>();

/** Begin recording. Multiple sessions may run concurrently; each
 *  receives every span (filtering by anim, if needed, is the caller's
 *  responsibility). The recorder stamps `span.start` / `span.end` from
 *  `anim.clock` on each open/close event, so the engine doesn't need
 *  to know anything about spans. */
export function record(anim: Anim): Recorder {
  const list: Span[] = [];
  const ver = signal(0);

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
    removeWriteHook = setSignalWriteHook(sig => {
      const s = currentSpan;
      if (s) s.touched.add(sig);
      const writer = writerOf.get(sig);
      if (writer) writer.value = s;
    });
  }

  const spansRead = computed(() => {
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

/** A representative active recorder, or undefined. Kept for tests
 *  that want a defensive teardown without tracking every recorder. */
export function activeRecorder(): Recorder | undefined {
  for (const r of recorders) return r;
  return undefined;
}

/** Read-only signal: the most recent span that wrote to `sig`, or
 *  undefined. Allocates one Signal<Span> per asked-about Signal,
 *  memoized via WeakMap. Cost outside `record()` is one map lookup. */
export function authorOf<T>(sig: Signal<T>): Read<Span | undefined> {
  let writer = writerOf.get(sig as Signal<unknown>);
  if (!writer) {
    writer = signal<Span | undefined>(undefined);
    writerOf.set(sig as Signal<unknown>, writer);
  }
  return writer;
}
