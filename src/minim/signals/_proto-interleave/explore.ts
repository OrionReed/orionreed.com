// _proto-interleave/explore.ts — sandbox for stateful-preemption ideas.
//
// We're testing different shapes of "process-with-state-preservation"
// against the real Anim runtime. Multiple variants so we can compare:
//
//   A. frozenInterleave — base advances when `when` false; interrupter
//      when true; non-active is frozen (its next() is not called).
//
//   B. carrying-dt — same but inactive child still gets dt each frame
//      (so wall-clock-dependent things keep aging).
//
//   C. stack — N processes; only the top one advances; arbitrary depth.
//
//   D. select — N branches; a reactive predicate picks which branch
//      advances. Generalises (A) and (C).
//
//   E. coroutine pipe — children call back to a coordinator via yields.
//      Closer to CSP / actors.

import type { Read } from "../signal";
import type { Animator, Tick } from "../../core";

// ── Helpers ──────────────────────────────────────────────────────

/** Read a Signal-ish or function-ish boolean. */
const readBool = (v: Read<boolean> | (() => boolean)): boolean =>
  typeof v === "function" ? v() : v.value;

// ── A. Frozen interleave ─────────────────────────────────────────
//
// Manual frame-by-frame driving. Restriction: children must be
// "well-behaved per-frame loops" — they yield undefined to wait for
// the next frame. They can return early. Other yield-shapes (suspend,
// nested generators) are NOT supported in this variant — those would
// need engine-level pause/resume.

export function* frozenInterleave<R>(
  when: Read<boolean> | (() => boolean),
  base: Animator<R>,
  interrupter: () => Animator<unknown>,
): Animator<R | undefined> {
  let inter: Animator<unknown> | null = null;
  while (true) {
    const tick: Tick = yield;
    const active = readBool(when);

    if (active) {
      // (Re-)build interrupter on entry.
      if (!inter) inter = interrupter();
      const r = inter.next(tick);
      if (r.done) inter = null;
      // base's .next() is NOT called → its state is preserved by JS.
    } else {
      // 'when' just flipped false; tear down any running interrupter.
      if (inter) {
        try { inter.return(undefined); } catch { /* ignore */ }
        inter = null;
      }
      const r = base.next(tick);
      if (r.done) return r.value as R;
    }
  }
}

// ── B. Carrying-dt interleave ────────────────────────────────────
//
// Variant of A: the inactive child STILL gets ticked every frame —
// but its writes-to-the-target are suppressed. Achieved by passing
// a "ghost" tick. (For our value model, this doesn't help directly —
// signals don't know who's writing. So this variant would need a
// per-writer-claim story at the signal level. Demonstrating the
// shape; not making it work yet.)
//
// In practice, "carry-dt" is most often what you want for
// time-dependent animations that shouldn't lose ground during
// pauses. But its implementation requires either (a) writer claims
// at the signal level, or (b) the inactive child running into a
// shadow signal and being copied over on resume.
//
// Skipping the implementation; documenting the shape.

// ── C. Stack ─────────────────────────────────────────────────────
//
// N processes with an "active index" that selects which one runs.
// Frozen = inactive ones don't advance. Generalises A. The active
// index can be reactive.

export function* stack<R>(
  layers: { when: Read<boolean> | (() => boolean); gen: () => Animator<unknown> }[],
  base: Animator<R>,
): Animator<R | undefined> {
  // `base` runs when no layer is active. Each layer is built lazily
  // on first activation and torn down when its `when` flips false.
  const built: (Animator<unknown> | null)[] = layers.map(() => null);
  while (true) {
    const tick: Tick = yield;
    // Find the topmost active layer (last-true wins — like z-index).
    let activeIdx = -1;
    for (let i = layers.length - 1; i >= 0; i--) {
      if (readBool(layers[i].when)) {
        activeIdx = i;
        break;
      }
    }

    // Tear down any built layers above the active one whose `when`
    // is now false (covered by activeIdx search, but also need to
    // tear down layers we *had* but no longer want active).
    for (let i = 0; i < layers.length; i++) {
      if (i !== activeIdx && built[i]) {
        try { built[i]!.return(undefined); } catch { /* ignore */ }
        built[i] = null;
      }
    }

    if (activeIdx === -1) {
      const r = base.next(tick);
      if (r.done) return r.value as R;
    } else {
      if (!built[activeIdx]) built[activeIdx] = layers[activeIdx].gen();
      const r = built[activeIdx]!.next(tick);
      if (r.done) built[activeIdx] = null;
    }
  }
}

// ── D. Select (the deepest version) ──────────────────────────────
//
// N labeled branches. A reactive *selector* function returns the
// active label per frame; that branch advances; all others freeze.
// Cleanest API for "this set of mutually-exclusive states."

export function* select<K extends string>(
  selector: () => K,
  branches: Record<K, () => Animator<unknown>>,
): Animator<void> {
  const built = {} as Record<string, Animator<unknown> | null>;
  let prev: K | null = null;
  while (true) {
    const tick: Tick = yield;
    const k = selector();
    if (k !== prev && prev !== null && built[prev]) {
      try { built[prev]!.return(undefined); } catch { /* ignore */ }
      built[prev] = null;
    }
    prev = k;
    if (!built[k]) built[k] = branches[k]();
    const r = built[k]!.next(tick);
    if (r.done) built[k] = null;
  }
}
