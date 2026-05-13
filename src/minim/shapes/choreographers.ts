// Multi-shape recipes. `swap`/`splay`/`assemble`/`stagger` are bounded
// (yield-array compositions over `.to(...)`); `orbit` is continuous (a
// `drive` step over N translates). For rigid group translate, reach for
// `centroid(...shapes).to(...)` instead.

import {
  delay,
  drive,
  toSig,
  type Animator,
  type Arg,
  type Easing,
} from "@minim/core";
import { isPoint, type V, type Pointlike } from "@minim/values";
import type { Writable } from "./shape";

/** Swap two shapes' positions over `sec`. */
export function* swap(
  a: Writable<"translate">,
  b: Writable<"translate">,
  sec = 0.5,
  ease?: Easing,
): Animator {
  const av = a.translate.peek();
  const bv = b.translate.peek();
  yield [a.translate.to(bv, sec, ease), b.translate.to(av, sec, ease)];
}

/** Run `fn(item)` for each item, lagged by `stride` seconds. All in
 *  parallel; completes when the longest child finishes:
 *  `yield* stagger(0.05, shapes, s => fadeIn(s, 0.3))`. */
export function* stagger<S>(
  stride: number,
  items: readonly S[],
  fn: (item: S, i: number) => Animator,
): Animator {
  yield items.map((item, i) => delay(i * stride, fn(item, i)));
}

/** Distribute shapes radially around `center` at `radius`, evenly
 *  spaced. Each shape tweens to its slot in parallel. */
export function* splay(
  center: Pointlike,
  radius: number,
  shapes: readonly Writable<"translate">[],
  sec = 0.5,
  ease?: Easing,
): Animator {
  const c = center.value;
  const N = shapes.length;
  yield shapes.map((s, i) => {
    // Start at top (-π/2) so first shape sits straight up; clockwise
    // — natural reading order for left-to-right layouts above.
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    return s.translate.to(
      { x: c.x + radius * Math.cos(angle), y: c.y + radius * Math.sin(angle) },
      sec,
      ease,
    );
  });
}

/** Tween each shape to its paired target (matched by index). */
export function* assemble(
  shapes: readonly Writable<"translate">[],
  targets: readonly (V | Pointlike)[],
  sec = 0.5,
  ease?: Easing,
): Animator {
  yield shapes.map((s, i) => {
    const t = targets[i];
    return s.translate.to(isPoint(t) ? t.value : t, sec, ease);
  });
}

/** Continuous orbit around `center`, one revolution per `period` seconds.
 *  Picks up each shape's current radius/angle (no jump). Never returns.
 *  `rate` is a reactive multiplier — tween for ease-in/out; negative
 *  reverses; 0 pauses. */
export function orbit(
  center: Pointlike,
  shapes: readonly Writable<"translate">[],
  opts: { period?: number; rate?: Arg<number> } = {},
): Animator {
  const period = opts.period ?? 4;
  const rate = toSig(opts.rate ?? 1);
  const omega = (2 * Math.PI) / period;
  const N = shapes.length;
  const c0 = center.value;
  const init = shapes.map((sh) => {
    const v = sh.translate.peek();
    const dx = v.x - c0.x;
    const dy = v.y - c0.y;
    return { angle: Math.atan2(dy, dx), radius: Math.hypot(dx, dy) };
  });
  let t = 0;
  return drive((dt) => {
    t += dt * rate.value;
    const c = center.value;
    for (let i = 0; i < N; i++) {
      const angle = init[i].angle + omega * t;
      shapes[i].translate.value = {
        x: c.x + init[i].radius * Math.cos(angle),
        y: c.y + init[i].radius * Math.sin(angle),
      };
    }
  });
}
