// Shared viewport cell — one lazy resize listener, re-emits on resize.

import { cell, type Cell, type ReadonlyCell } from "./core";

interface Viewport {
  w: number;
  h: number;
}

let cached: Cell<Viewport> | undefined;

export function viewport(): ReadonlyCell<Viewport> {
  if (cached) return cached;
  const sig = cell({ w: window.innerWidth, h: window.innerHeight });
  window.addEventListener("resize", () => {
    sig.value = { w: window.innerWidth, h: window.innerHeight };
  });
  cached = sig;
  return sig;
}
