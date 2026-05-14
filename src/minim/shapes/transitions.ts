// Bounded transitions composed from one primitive — `from(sig, start,
// end, sec, ease)` for intros (needs a start pose) and plain
// `sig.to(target, sec, ease)` for outros. Each compound `yield`s an
// array of those calls; the body shows exactly which atoms stack.

import {
  easeIn,
  easeInOut,
  easeOut,
  type Animator,
} from "@minim/core";
import {
  tween,
  type Cell,
  type Easing,
  type Val,
} from "@minim/signals";
import { type V, Dir } from "@minim/values";
import type { Writable } from "./shape";

type Lerpable = number | V;

// ── Primitive ────────────────────────────────────────────────────────

/** Pose-then-tween. Sets `sig.value = start` then tweens to `end`. */
export function* from<T extends Lerpable>(
  sig: Cell<T>,
  start: T,
  end: T,
  sec: Val<number> = 0.3,
  ease: Easing = easeOut,
): Animator {
  sig.value = start;
  yield* tween(sig, end, sec, ease);
}

// ── Atoms ────────────────────────────────────────────────────────────

/** Fade opacity 0 → 1. */
export function* fadeIn(
  s: Writable<"opacity">,
  sec: Val<number> = 0.3,
  ease: Easing = easeOut,
): Animator {
  yield* from(s.opacity, 0, 1, sec, ease);
}

/** Fade opacity 1 → 0. */
export function* fadeOut(
  s: Writable<"opacity">,
  sec: Val<number> = 0.3,
  ease: Easing = easeIn,
): Animator {
  yield* s.opacity.to(0, sec, ease);
}

// ── Compounds ────────────────────────────────────────────────────────

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
  yield [s.translate.to({ x: 0, y: -dy }, sec, easeIn), fadeOut(s, sec)];
}

/** Slide in from `dir` + fade in. */
export function* slideIn(
  s: Writable<"translate" | "opacity">,
  dir: V = Dir.Left,
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
  dir: V = Dir.Right,
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
  yield [s.scale.to({ x: 0, y: 0 }, sec, easeIn), fadeOut(s, sec)];
}

/** Overshoot-and-settle scale + fade in. */
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
