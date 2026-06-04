// Shared viewport signal — one lazy resize listener, re-emits on resize.

import { type Cell, cell } from "@minim/signals";

interface Viewport {
  w: number;
  h: number;
}

let cached: Cell<Viewport> | undefined;

export function viewport(): Cell<Viewport> {
  if (cached) return cached;
  const sig = cell({ w: window.innerWidth, h: window.innerHeight });
  window.addEventListener("resize", () => {
    sig.value = { w: window.innerWidth, h: window.innerHeight };
  });
  cached = sig;
  return sig;
}
