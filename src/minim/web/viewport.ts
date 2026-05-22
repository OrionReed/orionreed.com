// Shared viewport signal — one lazy resize listener, re-emits on resize.

import { type Signal, signal } from "@minim/signals";

interface Viewport {
  w: number;
  h: number;
}

let cached: Signal<Viewport> | undefined;

export function viewport(): Signal<Viewport> {
  if (cached) return cached;
  const sig = signal({ w: window.innerWidth, h: window.innerHeight });
  window.addEventListener("resize", () => {
    sig.value = { w: window.innerWidth, h: window.innerHeight };
  });
  cached = sig;
  return sig;
}
