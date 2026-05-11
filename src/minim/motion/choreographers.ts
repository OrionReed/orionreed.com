// Generator factories that animate N shapes in coordinated ways —
// built on yield-arrays + `sig.to`. For rigid group translate, reach
// for `centroid(...shapes).to(...)` instead; these are for non-rigid
// coordination (swap pairs, splay around a centre, orbit, etc.).

import { delay } from "./compose";
import {
  toSig,
  type Animator,
  type Arg,
  type Easing,
  type Vec,
} from "../core";
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

/** Continuous orbit around `center`, one revolution per `period`
 *  seconds. Picks up each shape's current radius/angle (no jump). Never
 *  returns. `rate` (default 1) is a reactive multiplier — tween it for
 *  ease-in/out; negatives reverse; 0 pauses. */
export function* orbit(
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
  while (true) {
    const dt = yield;
    t += dt * rate.value;
    const c = center.value;
    for (let i = 0; i < N; i++) {
      const angle = init[i].angle + omega * t;
      shapes[i].translate.value = {
        x: c.x + init[i].radius * Math.cos(angle),
        y: c.y + init[i].radius * Math.sin(angle),
      };
    }
  }
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
