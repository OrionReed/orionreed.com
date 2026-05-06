// Shared viewport signal — re-emits on window resize. One resize
// listener, attached lazily on first call.

import { signal, type ReadonlySignal, type Signal } from "./core";

interface Viewport {
  w: number;
  h: number;
}

let cached: Signal<Viewport> | undefined;

export function viewport(): ReadonlySignal<Viewport> {
  if (cached) return cached;
  const sig = signal({ w: window.innerWidth, h: window.innerHeight });
  window.addEventListener("resize", () => {
    sig.value = { w: window.innerWidth, h: window.innerHeight };
  });
  cached = sig;
  return sig;
}
