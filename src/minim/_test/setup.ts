// Stub RAF in Node so consumers calling `attachRaf()` don't crash;
// tests drive `step(dt)` directly so the RAF loop never fires.
const g = globalThis as any;
if (typeof g.requestAnimationFrame !== "function") {
  g.requestAnimationFrame = (_cb: (t: number) => void) => 0;
  g.cancelAnimationFrame = (_id: number) => {};
}
if (!g.performance) g.performance = { now: () => Date.now() };
