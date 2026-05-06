// Compositional enter/exit animations for Shapes. Each is a generator
// factory: sets the shape's initial state, animates to rest (intros)
// or from rest to invisible (outros). Compose with `lag`/`all`/`sequence`.

import { easeIn, easeInOut, easeOut } from "./easings";
import type { Animator, Writable } from "../core";

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

/** Translate from `dy` below + fade in. */
export function* fadeUp(
  s: Writable<"translate" | "opacity">,
  sec = 0.4,
  dy = 16,
): Animator {
  s.translate.value = { x: 0, y: dy };
  s.opacity.value = 0;
  yield [
    s.translate.to({ x: 0, y: 0 }, sec, easeOut),
    s.opacity.to(1, sec * 0.8),
  ];
}

/** Slide in from a side. Distance scales with default 30px. */
export function* slideIn(
  s: Writable<"translate" | "opacity">,
  from: "left" | "right" | "top" | "bottom" = "left",
  sec = 0.4,
  dist = 30,
): Animator {
  const off = {
    left: { x: -dist, y: 0 },
    right: { x: dist, y: 0 },
    top: { x: 0, y: -dist },
    bottom: { x: 0, y: dist },
  }[from];
  s.translate.value = off;
  s.opacity.value = 0;
  yield [
    s.translate.to({ x: 0, y: 0 }, sec, easeOut),
    s.opacity.to(1, sec * 0.7),
  ];
}

/** Scale 0 → 1. Pivot from the shape's pivot (default: bounds center). */
export function* scaleIn(s: Writable<"scale" | "opacity">, sec = 0.3): Animator {
  s.scale.value = { x: 0, y: 0 };
  s.opacity.value = 0;
  yield [
    s.scale.to({ x: 1, y: 1 }, sec, easeOut),
    s.opacity.to(1, sec * 0.7),
  ];
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
  yield [
    s.scale.to({ x: 0, y: 0 }, sec, easeIn),
    s.opacity.to(0, sec),
  ];
}

/** Translate up `dy` + fade out. */
export function* fadeUpOut(
  s: Writable<"translate" | "opacity">,
  sec = 0.3,
  dy = 16,
): Animator {
  yield [
    s.translate.to({ x: 0, y: -dy }, sec, easeIn),
    s.opacity.to(0, sec),
  ];
}

/** Slide out toward a side. */
export function* slideOut(
  s: Writable<"translate" | "opacity">,
  to: "left" | "right" | "top" | "bottom" = "right",
  sec = 0.3,
  dist = 30,
): Animator {
  const off = {
    left: { x: -dist, y: 0 },
    right: { x: dist, y: 0 },
    top: { x: 0, y: -dist },
    bottom: { x: 0, y: dist },
  }[to];
  yield [
    s.translate.to(off, sec, easeIn),
    s.opacity.to(0, sec),
  ];
}
