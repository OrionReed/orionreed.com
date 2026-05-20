// detach — spawn a child at engine root that outlives its caller.
// Built on `Suspend.ctx.spawn`; no engine cooperation beyond that.

import type { Animator } from "./anim";

/** Spawn `g` at engine root, resume parent immediately. Detached child
 *  outlives the spawning parent (survives parent cancel; dies on engine.stop()). */
export function* detach<R>(g: Animator<R>): Animator<void> {
  yield (wake, spawn) => {
    spawn(g);
    wake();
  };
}
