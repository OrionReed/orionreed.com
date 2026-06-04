// Forward-only adapters, used by the forward bench to measure the
// "bireactive tax" — minim's forward path is alien-signals verbatim, so
// the gap against raw alien/preact is the cost of carrying the backward
// machinery on every cell. These libraries have no write-through, so
// they implement `ForwardReactive` only.

import {
  batch as pBatch,
  computed as pComputed,
  effect as pEffect,
  signal as pSignal,
  untracked as pUntracked,
} from "@preact/signals-core";
import {
  computed as aComputed,
  effect as aEffect,
  signal as aSignal,
  endBatch,
  getActiveSub,
  setActiveSub,
  startBatch,
} from "alien-signals";
import type { ForwardReactive, Readable, Source } from "./types";

export const preact: ForwardReactive = {
  name: "preact",
  signal: <T>(initial: T): Source<T> => {
    const s = pSignal(initial);
    return { read: () => s.value, write: v => (s.value = v) };
  },
  computed: <T>(fn: () => T): Readable<T> => {
    const c = pComputed(fn);
    return { read: () => c.value };
  },
  effect: fn => pEffect(fn),
  batch: fn => pBatch(fn),
  untracked: fn => pUntracked(fn),
};

export const alien: ForwardReactive = {
  name: "alien",
  signal: <T>(initial: T): Source<T> => {
    const s = aSignal(initial);
    return { read: () => s(), write: v => s(v) };
  },
  computed: <T>(fn: () => T): Readable<T> => {
    const c = aComputed(fn);
    return { read: () => c() };
  },
  effect: fn => aEffect(fn),
  batch: fn => {
    startBatch();
    try {
      fn();
    } finally {
      endBatch();
    }
  },
  untracked: <T>(fn: () => T): T => {
    const prev = setActiveSub(undefined);
    try {
      return fn();
    } finally {
      setActiveSub(prev);
    }
  },
};

void getActiveSub;
