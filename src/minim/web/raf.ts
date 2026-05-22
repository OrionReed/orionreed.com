// requestAnimationFrame adapter for the engine. Lives in `web/`
// because it depends on the browser; core is renderer-agnostic.

/** Drive `anim.step(dt)` on every animation frame. Caps `dt` at 32 ms
 *  so a backgrounded tab doesn't deliver one giant frame on resume.
 *  Returns a disposer. */
export function attachRaf(anim: { step(dt: number): void }): () => void {
  if (typeof requestAnimationFrame !== "function") return () => {};
  const FRAME_CAP_MS = 32;
  let rafId = 0,
    last = 0;
  const tick = (now: number): void => {
    rafId = requestAnimationFrame(tick);
    const dt = last ? Math.min(now - last, FRAME_CAP_MS) / 1000 : 0;
    last = now;
    anim.step(dt);
  };
  rafId = requestAnimationFrame(tick);
  return () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    last = 0;
  };
}
