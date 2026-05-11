// Multi-shape recipes — yield-array compositions over N shapes that
// each animate one signal per shape. Pure sugar over `.to(...)` and
// `yield [...]`; named for the intent. For rigid group translate,
// reach for `centroid(...shapes).to(...)` instead. For continuous
// circular motion, see `orbit` in `motion/integrators.ts`.

import type { Animator, Easing, Vec } from "../core";
import { delay } from "../core";
import { isPoint, type Pointlike, type Writable } from "../scene";

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

/** Tween each shape to its paired target (matched by index). Targets
 *  may be `Vec` literals or any `Pointlike`. */
export function* assemble(
  shapes: readonly Writable<"translate">[],
  targets: readonly (Vec | Pointlike)[],
  sec = 0.5,
  ease?: Easing,
): Animator {
  yield shapes.map((s, i) => {
    const t = targets[i];
    return s.translate.to(isPoint(t) ? t.value : t, sec, ease);
  });
}
