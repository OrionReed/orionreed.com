// Bounded transitions. `from(sig, start, end)` for intros, `sig.to(target)` for outros.

import {easeIn, easeInOut, easeOut, type Animator, type Yieldable} from "@minim/core";
import {tween, Dir, type Signal, type Easing, type Val, type VecValue} from "@minim/signals";
import type {Has} from "./shape";

/** Eagerly advance `factory()` to its first yield (flushing pose side-
 *  effects), then return an Animator that re-yields and forwards the
 *  resumed value back into the inner gen. (Plain `yield* g` would
 *  discard the first resume — the spec calls `g.next()` with no arg —
 *  so a tween's `dt = yield` would get `undefined` on its first wake.) */
const eager = <R>(factory: () => Animator<R>): Animator<R> => {
  const g = factory();
  const first = g.next();
  return (function* (): Animator<R> {
    if (first.done) return first.value;
    let r: any = yield first.value as Yieldable;
    try {
      while (true) {
        const step = g.next(r);
        if (step.done) return step.value;
        r = yield step.value;
      }
    } finally {
      g.return(undefined as any);
    }
  })();
};

/** Pose-then-tween. Sets `sig.value = start` synchronously, then tweens
 *  to `end`. */
export const from = <T>(
  sig: Signal<T>,
  start: T,
  end: T,
  sec: Val<number> = 0.3,
  ease: Easing = easeOut,
): Animator =>
  eager(function* () {
    sig.value = start;
    yield* tween(sig, end, sec, ease);
  });

/** Fade opacity 0 → 1. */
export const fadeIn = (
  s: Has<"opacity">,
  sec: Val<number> = 0.3,
  ease: Easing = easeOut,
): Animator => from(s.opacity, 0, 1, sec, ease);

/** Fade opacity 1 → 0. */
export function* fadeOut(
  s: Has<"opacity">,
  sec: Val<number> = 0.3,
  ease: Easing = easeIn,
): Animator {
  yield* s.opacity.to(0, sec, ease);
}

/** Slide up from `dy` below + fade in. */
export const fadeUp = (
  s: Has<"translate" | "opacity">,
  sec = 0.4,
  dy = 16,
): Animator =>
  eager(function* () {
    yield [
      from(s.translate, { x: 0, y: dy }, { x: 0, y: 0 }, sec, easeOut),
      fadeIn(s, sec * 0.8),
    ];
  });

/** Slide up + fade out. Mirror of `fadeUp`. */
export function* fadeUpOut(
  s: Has<"translate" | "opacity">,
  sec = 0.3,
  dy = 16,
): Animator {
  yield [s.translate.to({ x: 0, y: -dy }, sec, easeIn), fadeOut(s, sec)];
}

/** Slide in from `dir` + fade in. */
export const slideIn = (
  s: Has<"translate" | "opacity">,
  dir: VecValue = Dir.Left,
  sec = 0.4,
  dist = 30,
): Animator =>
  eager(function* () {
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
  });

/** Slide out toward a side + fade out. */
export function* slideOut(
  s: Has<"translate" | "opacity">,
  dir: VecValue = Dir.Right,
  sec = 0.3,
  dist = 30,
): Animator {
  yield [
    s.translate.to({ x: dir.x * dist, y: dir.y * dist }, sec, easeIn),
    fadeOut(s, sec),
  ];
}

/** Scale 0 → 1 + fade in. */
export const scaleIn = (
  s: Has<"scale" | "opacity">,
  sec = 0.3,
): Animator =>
  eager(function* () {
    yield [
      from(s.scale, { x: 0, y: 0 }, { x: 1, y: 1 }, sec, easeOut),
      fadeIn(s, sec * 0.7),
    ];
  });

/** Scale 1 → 0 + fade out. */
export function* zoomOut(
  s: Has<"scale" | "opacity">,
  sec = 0.3,
): Animator {
  yield [s.scale.to({ x: 0, y: 0 }, sec, easeIn), fadeOut(s, sec)];
}

/** Overshoot-and-settle scale + fade in. */
export const bounceIn = (
  s: Has<"scale" | "opacity">,
  sec = 0.5,
): Animator =>
  eager(function* () {
    s.scale.value = { x: 0, y: 0 };
    yield [
      fadeIn(s, sec * 0.5),
      s.scale
        .to({ x: 1.18, y: 1.18 }, sec * 0.7, easeOut)
        .to({ x: 1, y: 1 }, sec * 0.3, easeInOut),
    ];
  });

/** Spin in: rotate -π → 0 + scale 0.5 → 1 + fade in. */
export const spinIn = (
  s: Has<"rotate" | "scale" | "opacity">,
  sec = 0.5,
): Animator =>
  eager(function* () {
    yield [
      from(s.rotate, -Math.PI, 0, sec, easeOut),
      from(s.scale, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }, sec, easeOut),
      fadeIn(s, sec * 0.7),
    ];
  });
