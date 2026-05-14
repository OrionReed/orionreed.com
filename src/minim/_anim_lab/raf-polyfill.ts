// Stub RAF for Node — engines call requestAnimationFrame on spawn to
// keep the loop alive in browsers. In bench/test we drive `step()`
// directly, so RAF never needs to fire; just no-op.
const g = globalThis as any;
if (typeof g.requestAnimationFrame !== "function") {
  g.requestAnimationFrame = (_cb: (t: number) => void) => 0;
  g.cancelAnimationFrame = (_id: number) => {};
  g.performance = g.performance ?? { now: () => Date.now() };
}
