// Compositional enter/exit animations for Shapes. Each is a generator
// factory: sets the shape's initial state, animates to rest (intros)
// or from rest to invisible (outros). Compose with `lag`/`all`/`sequence`.
//
// Single-axis intros (`fadeUp`, `slideIn`, `fadeUpOut`, `slideOut`) tween
// only the axis they affect via the lens-backed `.x` / `.y` signals;
// orthogonal axes are reset once at the top and then left untouched, so
// concurrent tweens on the other axis compose correctly.

import { easeIn, easeInOut, easeOut } from "./easings";
import type { Animator } from "../core";
import type { Writable } from "../scene";

// Each helper constrains only the props it animates via `Writable<K>`
// — leaving other props free to be readonly. e.g. a
// `group({ translate: computed(...) })` is still a valid `bounceIn`
// target because bounceIn only touches `scale`/`opacity`.

// ── Intros ───────────────────────────────────────────────────────────

/** Opacity 0 → 1. */
export function* fadeIn(s: Writable<"opacity">, sec = 0.3): Animator {
  s.opacity.value = 0;
  yield* s.opacity.to(1, sec);
}

/** Translate from `dy` below + fade in. Only the y-axis is tweened. */
export function* fadeUp(
  s: Writable<"translate" | "opacity">,
  sec = 0.4,
  dy = 16,
): Animator {
  s.translate.value = { x: 0, y: dy };
  s.opacity.value = 0;
  yield [s.translate.y.to(0, sec, easeOut), s.opacity.to(1, sec * 0.8)];
}

/** Slide in from a side. Only the affected axis is tweened. */
export function* slideIn(
  s: Writable<"translate" | "opacity">,
  from: "left" | "right" | "top" | "bottom" = "left",
  sec = 0.4,
  dist = 30,
): Animator {
  s.translate.value = {
    x: from === "left" ? -dist : from === "right" ? dist : 0,
    y: from === "top" ? -dist : from === "bottom" ? dist : 0,
  };
  s.opacity.value = 0;
  const horizontal = from === "left" || from === "right";
  const axisTween = horizontal
    ? s.translate.x.to(0, sec, easeOut)
    : s.translate.y.to(0, sec, easeOut);
  yield [axisTween, s.opacity.to(1, sec * 0.7)];
}

/** Scale 0 → 1. Pivot from the shape's pivot (default: bounds center). */
export function* scaleIn(s: Writable<"scale" | "opacity">, sec = 0.3): Animator {
  s.scale.value = { x: 0, y: 0 };
  s.opacity.value = 0;
  yield [s.scale.to({ x: 1, y: 1 }, sec, easeOut), s.opacity.to(1, sec * 0.7)];
}

/** Overshoot-and-settle scale. Classic "bounceIn". */
export function* bounceIn(s: Writable<"scale" | "opacity">, sec = 0.5): Animator {
  s.scale.value = { x: 0, y: 0 };
  s.opacity.value = 0;
  yield [
    s.opacity.to(1, sec * 0.5),
    s.scale
      .to({ x: 1.18, y: 1.18 }, sec * 0.7, easeOut)
      .to({ x: 1, y: 1 }, sec * 0.3, easeInOut),
  ];
}

/** Spin in: rotate from -180° to 0°, fade in, scale from 0.5 → 1. */
export function* spinIn(
  s: Writable<"rotate" | "scale" | "opacity">,
  sec = 0.5,
): Animator {
  s.rotate.value = -Math.PI;
  s.scale.value = { x: 0.5, y: 0.5 };
  s.opacity.value = 0;
  yield [
    s.rotate.to(0, sec, easeOut),
    s.scale.to({ x: 1, y: 1 }, sec, easeOut),
    s.opacity.to(1, sec * 0.7),
  ];
}

// ── Outros ───────────────────────────────────────────────────────────

export function* fadeOut(s: Writable<"opacity">, sec = 0.3): Animator {
  yield* s.opacity.to(0, sec);
}

/** Scale to 0 + fade out. Mirror of scaleIn. */
export function* zoomOut(s: Writable<"scale" | "opacity">, sec = 0.3): Animator {
  yield [s.scale.to({ x: 0, y: 0 }, sec, easeIn), s.opacity.to(0, sec)];
}

/** Translate up `dy` + fade out. Only the y-axis is tweened. */
export function* fadeUpOut(
  s: Writable<"translate" | "opacity">,
  sec = 0.3,
  dy = 16,
): Animator {
  yield [s.translate.y.to(-dy, sec, easeIn), s.opacity.to(0, sec)];
}

/** Slide out toward a side. Only the affected axis is tweened. */
export function* slideOut(
  s: Writable<"translate" | "opacity">,
  to: "left" | "right" | "top" | "bottom" = "right",
  sec = 0.3,
  dist = 30,
): Animator {
  const horizontal = to === "left" || to === "right";
  const target = to === "left" || to === "top" ? -dist : dist;
  const axisTween = horizontal
    ? s.translate.x.to(target, sec, easeIn)
    : s.translate.y.to(target, sec, easeIn);
  yield [axisTween, s.opacity.to(0, sec)];
}
