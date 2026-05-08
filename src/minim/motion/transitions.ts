// Transitions are compositions of one tiny primitive — `from(sig, start,
// end, sec, ease)` — for intros (which need a starting pose) and the
// existing `sig.to(target, sec, ease)` for outros (which don't). Each
// compound `yield`s an array of those calls; reading the body shows
// exactly which atoms it stacks.

import { tween, type Duration, type Easing, type Signal } from "../core";
import type { Animator, Vec } from "../core";
import type { Writable } from "../scene";
import { easeIn, easeInOut, easeOut } from "./easings";

type Lerpable = number | Vec;

// ── Primitive ────────────────────────────────────────────────────────

/** Pose-then-tween. Sets `sig.value = start` and animates to `end`
 *  over `sec` seconds. The atom every intro is built from. Outros
 *  don't need it — they just `sig.to(target, sec, ease)` from rest. */
export function* from<T extends Lerpable>(
  sig: Signal<T>,
  start: T,
  end: T,
  sec: Duration = 0.3,
  ease: Easing = easeOut,
): Animator {
  sig.value = start;
  yield* tween(sig, end, sec, ease);
}

// ── Direction constants — paired with `slideIn` / `slideOut` ─────────

/** Named unit direction vectors. Pass to `slideIn` / `slideOut`, or
 *  use any other `Vec` for diagonals (`{ x: 0.7, y: 0.7 }` etc.). */
export const Dir = {
  Left:  { x: -1, y:  0 } as Vec,
  Right: { x:  1, y:  0 } as Vec,
  Up:    { x:  0, y: -1 } as Vec,
  Down:  { x:  0, y:  1 } as Vec,
};

// ── Atoms ────────────────────────────────────────────────────────────

/** Opacity 0 → 1. */
export function* fadeIn(
  s: Writable<"opacity">,
  sec: Duration = 0.3,
  ease: Easing = easeOut,
): Animator {
  yield* from(s.opacity, 0, 1, sec, ease);
}

/** Opacity 1 → 0. */
export function* fadeOut(
  s: Writable<"opacity">,
  sec: Duration = 0.3,
  ease: Easing = easeIn,
): Animator {
  yield* s.opacity.to(0, sec, ease);
}

// ── Compounds — each body shows exactly which atoms it stacks ───────

/** Slide up from `dy` below + fade in. */
export function* fadeUp(
  s: Writable<"translate" | "opacity">,
  sec = 0.4,
  dy = 16,
): Animator {
  yield [
    from(s.translate, { x: 0, y: dy }, { x: 0, y: 0 }, sec, easeOut),
    fadeIn(s, sec * 0.8),
  ];
}

/** Slide up + fade out. Mirror of `fadeUp`. */
export function* fadeUpOut(
  s: Writable<"translate" | "opacity">,
  sec = 0.3,
  dy = 16,
): Animator {
  yield [
    s.translate.to({ x: 0, y: -dy }, sec, easeIn),
    fadeOut(s, sec),
  ];
}

/** Slide in from a side + fade in. `dir` is a unit `Vec` — use `Dir.Left`
 *  / `Dir.Up` / etc. for cardinals, or any other unit-ish vector. */
export function* slideIn(
  s: Writable<"translate" | "opacity">,
  dir: Vec = Dir.Left,
  sec = 0.4,
  dist = 30,
): Animator {
  yield [
    from(
      s.translate,
      { x: dir.x * dist, y: dir.y * dist },
      { x: 0, y: 0 },
      sec,
      easeOut,
    ),
    fadeIn(s, sec * 0.7),
  ];
}

/** Slide out toward a side + fade out. */
export function* slideOut(
  s: Writable<"translate" | "opacity">,
  dir: Vec = Dir.Right,
  sec = 0.3,
  dist = 30,
): Animator {
  yield [
    s.translate.to({ x: dir.x * dist, y: dir.y * dist }, sec, easeIn),
    fadeOut(s, sec),
  ];
}

/** Scale 0 → 1 + fade in. */
export function* scaleIn(
  s: Writable<"scale" | "opacity">,
  sec = 0.3,
): Animator {
  yield [
    from(s.scale, { x: 0, y: 0 }, { x: 1, y: 1 }, sec, easeOut),
    fadeIn(s, sec * 0.7),
  ];
}

/** Scale 1 → 0 + fade out. */
export function* zoomOut(
  s: Writable<"scale" | "opacity">,
  sec = 0.3,
): Animator {
  yield [
    s.scale.to({ x: 0, y: 0 }, sec, easeIn),
    fadeOut(s, sec),
  ];
}

/** Overshoot-and-settle scale + fade in. The two-phase chain on `scale`
 *  isn't expressible as a single `from` — `.to(...).to(...)` chains
 *  inline. */
export function* bounceIn(
  s: Writable<"scale" | "opacity">,
  sec = 0.5,
): Animator {
  s.scale.value = { x: 0, y: 0 };
  yield [
    fadeIn(s, sec * 0.5),
    s.scale
      .to({ x: 1.18, y: 1.18 }, sec * 0.7, easeOut)
      .to({ x: 1, y: 1 }, sec * 0.3, easeInOut),
  ];
}

/** Spin in: rotate -π → 0 + scale 0.5 → 1 + fade in. */
export function* spinIn(
  s: Writable<"rotate" | "scale" | "opacity">,
  sec = 0.5,
): Animator {
  yield [
    from(s.rotate, -Math.PI, 0, sec, easeOut),
    from(s.scale, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }, sec, easeOut),
    fadeIn(s, sec * 0.7),
  ];
}
