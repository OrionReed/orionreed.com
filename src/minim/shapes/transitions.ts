// Bounded transitions. Pose writes happen synchronously at the call
// boundary; the returned value is the *time-varying part only*. Single-
// axis transitions return a `Tween` (an Animator); multi-axis transitions
// return a `Yieldable[]` (a parallel array). In both cases callers do
// `yield transitionName(s)` — the engine handles arrays natively, and a
// Tween is yield-able by virtue of being an Animator.

import {easeIn, easeInOut, easeOut, type Easing, type Yieldable} from "@minim/core";
import {tween, Dir, type Val, type VecValue} from "@minim/signals";
import type {Has} from "./shape";

/** Fade opacity 0 → 1. */
export const fadeIn = (
  s: Has<"opacity">,
  sec: Val<number> = 0.3,
  ease: Easing = easeOut,
): Yieldable => tween(s.opacity, 1, sec, ease).from(0);

/** Fade opacity 1 → 0. */
export const fadeOut = (
  s: Has<"opacity">,
  sec: Val<number> = 0.3,
  ease: Easing = easeIn,
): Yieldable => tween(s.opacity, 0, sec, ease);

/** Slide up from `dy` below + fade in. */
export function fadeUp(
  s: Has<"translate" | "opacity">,
  sec = 0.4,
  dy = 16,
): Yieldable {
  s.translate.value = { x: 0, y: dy };
  s.opacity.value = 0;
  return [
    tween(s.translate, { x: 0, y: 0 }, sec, easeOut),
    tween(s.opacity, 1, sec * 0.8),
  ];
}

/** Slide up + fade out. Mirror of `fadeUp`. */
export const fadeUpOut = (
  s: Has<"translate" | "opacity">,
  sec = 0.3,
  dy = 16,
): Yieldable => [
  tween(s.translate, { x: 0, y: -dy }, sec, easeIn),
  tween(s.opacity, 0, sec, easeIn),
];

/** Slide in from `dir` + fade in. */
export function slideIn(
  s: Has<"translate" | "opacity">,
  dir: VecValue = Dir.Left,
  sec = 0.4,
  dist = 30,
): Yieldable {
  s.translate.value = { x: dir.x * dist, y: dir.y * dist };
  s.opacity.value = 0;
  return [
    tween(s.translate, { x: 0, y: 0 }, sec, easeOut),
    tween(s.opacity, 1, sec * 0.7),
  ];
}

/** Slide out toward a side + fade out. */
export const slideOut = (
  s: Has<"translate" | "opacity">,
  dir: VecValue = Dir.Right,
  sec = 0.3,
  dist = 30,
): Yieldable => [
  tween(s.translate, { x: dir.x * dist, y: dir.y * dist }, sec, easeIn),
  tween(s.opacity, 0, sec, easeIn),
];

/** Scale 0 → 1 + fade in. */
export function scaleIn(
  s: Has<"scale" | "opacity">,
  sec = 0.3,
): Yieldable {
  s.scale.value = { x: 0, y: 0 };
  s.opacity.value = 0;
  return [
    tween(s.scale, { x: 1, y: 1 }, sec, easeOut),
    tween(s.opacity, 1, sec * 0.7),
  ];
}

/** Scale 1 → 0 + fade out. */
export const zoomOut = (
  s: Has<"scale" | "opacity">,
  sec = 0.3,
): Yieldable => [
  tween(s.scale, { x: 0, y: 0 }, sec, easeIn),
  tween(s.opacity, 0, sec, easeIn),
];

/** Overshoot-and-settle scale + fade in. */
export function bounceIn(
  s: Has<"scale" | "opacity">,
  sec = 0.5,
): Yieldable {
  s.scale.value = { x: 0, y: 0 };
  s.opacity.value = 0;
  return [
    tween(s.opacity, 1, sec * 0.5),
    s.scale
      .to({ x: 1.18, y: 1.18 }, sec * 0.7, easeOut)
      .to({ x: 1, y: 1 }, sec * 0.3, easeInOut),
  ];
}

/** Spin in: rotate -π → 0 + scale 0.5 → 1 + fade in. */
export function spinIn(
  s: Has<"rotate" | "scale" | "opacity">,
  sec = 0.5,
): Yieldable {
  s.rotate.value = -Math.PI;
  s.scale.value = { x: 0.5, y: 0.5 };
  s.opacity.value = 0;
  return [
    tween(s.rotate, 0, sec, easeOut),
    tween(s.scale, { x: 1, y: 1 }, sec, easeOut),
    tween(s.opacity, 1, sec * 0.7),
  ];
}
