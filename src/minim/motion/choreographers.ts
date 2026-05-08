// Group choreographers — generator factories that animate N shapes
// in coordinated ways. Built on the existing yield protocol (parallel
// arrays + `sig.to`); no new runtime concepts. Each is small enough
// to read top-to-bottom; pick whichever's named for what you want.
//
// For "translate the whole group rigidly" the better answer is
// `centroid(...shapes).to(target, sec)` — that's a writable lens,
// not a choreographer. These factories are for non-rigid coordination
// (swap pairs, splay around a centre, orbit, lay out to specific
// targets, stagger an op).

import { lag } from "./compose";
import type { Animator, Easing, Vec } from "../core";
import { isPoint, type Pointlike, type Writable } from "../scene";

/** Swap two shapes' positions. Each tweens to the other's current
 *  translate over `sec`. */
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

/** Apply `fn` to each item with a per-index time offset (`stride`
 *  seconds between starts). Sugar over `lag` for shape-keyed ops:
 *  `yield* stagger(0.05, shapes, (s) => fadeIn(s, 0.3))`. */
export function* stagger<S>(
  stride: number,
  items: readonly S[],
  fn: (item: S, i: number) => Animator,
): Animator {
  yield* lag(stride, ...items.map((item, i) => fn(item, i)));
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

/** Continuous orbital motion — each shape moves on a circle of
 *  `radius` around `center`, evenly phased, completing one revolution
 *  in `period` seconds. Never returns; cancel via the `run` disposer
 *  or include it in a `race`. */
export function* orbit(
  center: Pointlike,
  shapes: readonly Writable<"translate">[],
  opts: { radius?: number; period?: number } = {},
): Animator {
  const radius = opts.radius ?? 60;
  const period = opts.period ?? 4;
  const omega = (2 * Math.PI) / period;
  const N = shapes.length;
  let t = 0;
  while (true) {
    const dt: number = yield;
    t += dt;
    const c = center.value;
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 + omega * t;
      shapes[i].translate.value = {
        x: c.x + radius * Math.cos(angle),
        y: c.y + radius * Math.sin(angle),
      };
    }
  }
}

/** Tween each shape to its paired target. The arrays line up by
 *  index — `shapes[i].translate` animates to `targets[i]`. Targets
 *  can be plain `Vec` literals or any `Pointlike` (e.g. another
 *  shape's `bounds.center`). */
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
