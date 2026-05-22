// _proto-exp/undo.ts — undo/time-travel via lens inverses.
//
// Provocation: if every reactive write goes through a lens with an
// inverse, then time-travel is a natural fall-out. Record (target,
// prev, next) on each write; to undo, apply prev back.
//
// This is genuinely novel to the lens-first approach. With raw signals
// you'd need to wrap every write site by hand. With lenses, the
// inverse is already there — the engine just needs to record it.
//
// Sketch implementation: a global write-recorder that captures every
// `set value` call. Undo applies recorded writes in reverse.

import { Source, Derived } from "../_proto-cell2/cell2";

type Recorder = (cell: Source<unknown> | Derived<unknown>, prev: unknown, next: unknown) => void;

let activeRecorder: Recorder | undefined;

/** Run `fn` with all writes recorded into `history`. */
export function record<R>(history: Array<{ cell: unknown; prev: unknown; next: unknown }>, fn: () => R): R {
  const prev = activeRecorder;
  activeRecorder = (cell, p, n) => { history.push({ cell, prev: p, next: n }) };
  try {
    return fn();
  } finally {
    activeRecorder = prev;
  }
}

/** Reverse the recorded writes in `history`, popping them off. The
 *  source cells must support direct `.value =`. */
export function undo(history: Array<{ cell: unknown; prev: unknown; next: unknown }>): void {
  for (let i = history.length - 1; i >= 0; i--) {
    const { cell, prev } = history[i];
    (cell as { value: unknown }).value = prev;
  }
  history.length = 0;
}

/** Wrap a Source<T> so its writes get recorded. */
export class RecordingSource<T> extends Source<T> {
  set value(v: T) {
    // Capture prev via peek (honors dirty + commits pending).
    const prev = this.peek();
    super.value = v;
    if (activeRecorder !== undefined) activeRecorder(this as unknown as Source<unknown>, prev, v);
  }
  // Inheriting `get value` is non-trivial in TS due to setter override; redeclare.
  get value(): T { return super.value }
}

export function recordingSource<T>(initial: T): RecordingSource<T> {
  return new RecordingSource(initial);
}
