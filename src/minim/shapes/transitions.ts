// Bounded transitions. Pose writes happen synchronously at the call
// boundary; the returned Animator runs only the time-varying part. Use
// `yield* fadeIn(s)` for single-axis (returns a Tween, which is itself
// an Animator) or `yield fadeUp(s)` for multi-axis (returns a generator
// that yields a parallel array).

import {easeIn, easeInOut, easeOut, type Animator, type Easing} from "@minim/core";
import {tween, Dir, type Signal, type Val, type VecValue} from "@minim/signals";
import type {Has} from "./shape";

/** Pose `sig.value = start` synchronously, then tween to `end`. */
export const from = <T>(
  sig: Signal<T>,
  start: T,
  end: T,
  sec: Val<number> = 0.3,
  ease: Easing = easeOut,
): Animator => {
  sig.value = start;
  return tween(sig, end, sec, ease);
};

/** Fade opacity 0 → 1. */
export const fadeIn = (
  s: Has<"opacity">,
  sec: Val<number> = 0.3,
  ease: Easing = easeOut,
): Animator => from(s.opacity, 0, 1, sec, ease);

/** Fade opacity 1 → 0. */
export const fadeOut = (
  s: Has<"opacity">,
  sec: Val<number> = 0.3,
  ease: Easing = easeIn,
): Animator => tween(s.opacity, 0, sec, ease);

/** Slide up from `dy` below + fade in. */
export function fadeUp(
  s: Has<"translate" | "opacity">,
  sec = 0.4,
  dy = 16,
): Animator {
  s.translate.value = { x: 0, y: dy };
  s.opacity.value = 0;
  return (function* () {
    yield [
      tween(s.translate, { x: 0, y: 0 }, sec, easeOut),
      tween(s.opacity, 1, sec * 0.8),
    ];
  })();
}

/** Slide up + fade out. Mirror of `fadeUp`. */
export function fadeUpOut(
  s: Has<"translate" | "opacity">,
  sec = 0.3,
  dy = 16,
): Animator {
  return (function* () {
    yield [
      tween(s.translate, { x: 0, y: -dy }, sec, easeIn),
      tween(s.opacity, 0, sec, easeIn),
    ];
  })();
}

/** Slide in from `dir` + fade in. */
export function slideIn(
  s: Has<"translate" | "opacity">,
  dir: VecValue = Dir.Left,
  sec = 0.4,
  dist = 30,
): Animator {
  s.translate.value = { x: dir.x * dist, y: dir.y * dist };
  s.opacity.value = 0;
  return (function* () {
    yield [
      tween(s.translate, { x: 0, y: 0 }, sec, easeOut),
      tween(s.opacity, 1, sec * 0.7),
    ];
  })();
}

/** Slide out toward a side + fade out. */
export function slideOut(
  s: Has<"translate" | "opacity">,
  dir: VecValue = Dir.Right,
  sec = 0.3,
  dist = 30,
): Animator {
  return (function* () {
    yield [
      tween(s.translate, { x: dir.x * dist, y: dir.y * dist }, sec, easeIn),
      tween(s.opacity, 0, sec, easeIn),
    ];
  })();
}

/** Scale 0 → 1 + fade in. */
export function scaleIn(
  s: Has<"scale" | "opacity">,
  sec = 0.3,
): Animator {
  s.scale.value = { x: 0, y: 0 };
  s.opacity.value = 0;
  return (function* () {
    yield [
      tween(s.scale, { x: 1, y: 1 }, sec, easeOut),
      tween(s.opacity, 1, sec * 0.7),
    ];
  })();
}

/** Scale 1 → 0 + fade out. */
export function zoomOut(
  s: Has<"scale" | "opacity">,
  sec = 0.3,
): Animator {
  return (function* () {
    yield [
      tween(s.scale, { x: 0, y: 0 }, sec, easeIn),
      tween(s.opacity, 0, sec, easeIn),
    ];
  })();
}

/** Overshoot-and-settle scale + fade in. */
export function bounceIn(
  s: Has<"scale" | "opacity">,
  sec = 0.5,
): Animator {
  s.scale.value = { x: 0, y: 0 };
  s.opacity.value = 0;
  return (function* () {
    yield [
      tween(s.opacity, 1, sec * 0.5),
      s.scale
        .to({ x: 1.18, y: 1.18 }, sec * 0.7, easeOut)
        .to({ x: 1, y: 1 }, sec * 0.3, easeInOut),
    ];
  })();
}

/** Spin in: rotate -π → 0 + scale 0.5 → 1 + fade in. */
export function spinIn(
  s: Has<"rotate" | "scale" | "opacity">,
  sec = 0.5,
): Animator {
  s.rotate.value = -Math.PI;
  s.scale.value = { x: 0.5, y: 0.5 };
  s.opacity.value = 0;
  return (function* () {
    yield [
      tween(s.rotate, 0, sec, easeOut),
      tween(s.scale, { x: 1, y: 1 }, sec, easeOut),
      tween(s.opacity, 1, sec * 0.7),
    ];
  })();
}
