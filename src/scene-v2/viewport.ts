// Global viewport signal — re-evaluates on window resize. Used by
// diagrams that vary layout by viewport (mobile vs desktop, fluid widths).
//
// One listener attached lazily on first call; the signal is shared across
// all callers in the page.

import { signal, type ReadonlySignal, type Signal } from "./signal";

interface Viewport {
  w: number;
  h: number;
}

let cached: Signal<Viewport> | undefined;

export function useViewport(): ReadonlySignal<Viewport> {
  if (cached) return cached;
  const sig = signal({ w: window.innerWidth, h: window.innerHeight });
  window.addEventListener("resize", () => {
    sig.value = { w: window.innerWidth, h: window.innerHeight };
  });
  cached = sig;
  return sig;
}
