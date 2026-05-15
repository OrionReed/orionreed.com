// Test setup: stub RAF for Node so engines that internally call
// requestAnimationFrame don't crash. Tests drive `step(dt)` directly,
// so RAF never needs to fire.
const g = globalThis as any;
if (typeof g.requestAnimationFrame !== "function") {
  g.requestAnimationFrame = (_cb: (t: number) => void) => 0;
  g.cancelAnimationFrame = (_id: number) => {};
}
if (!g.performance) g.performance = { now: () => Date.now() };
