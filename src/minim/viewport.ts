// Shared viewport signal — one lazy resize listener, re-emits on
// window resize.

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
