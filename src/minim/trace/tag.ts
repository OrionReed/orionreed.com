// Identity for traced generators. Wrap an animator factory with `tag`
// and each generator instance it produces carries a `__minimTag` string
// the runtime peeks at spawn time and copies onto `Span.tag`. No fork
// of `Signal` and no instrumentation of the runtime — purely an opt-in
// label on the gen object that the trace machinery reads if present.
//
// Use at the call site, not inside the lib's primitives. Library
// recipes (`fadeIn`, `tween`, …) stay untagged so production code
// pays nothing; demos/tests tag at the top of their own files:
//
//     const t = tagAll({ fadeIn, fadeUp, fooBar });
//     anim.run(function*() {
//       yield [t.fadeIn(a, 0.3), t.fadeUp(b, 0.5)];
//     });

import { TAG_KEY, type Animator } from "../core/anim";

type AnyAnimFactory = (...args: any[]) => Animator;

/** Wrap an animator factory so each generator it produces carries
 *  `name` (or `fn.name` if omitted). The wrapper preserves the
 *  factory's call signature; types flow through. */
export function tag<F extends AnyAnimFactory>(fn: F, name?: string): F {
  const tagName = name ?? fn.name;
  return ((...args: Parameters<F>) => {
    const g = fn(...args);
    (g as unknown as Record<string, unknown>)[TAG_KEY] = tagName;
    return g;
  }) as F;
}

/** Batch-tag a record of factories. Object keys become the tags —
 *  pair with JS shorthand for one-name-per-recipe ergonomics:
 *
 *      const t = tagAll({ fadeIn, fadeUp, spinIn });
 *      // t.fadeIn / t.fadeUp / t.spinIn now produce tagged generators.
 *
 *  Types are preserved: `t.fadeIn` has the exact same signature as
 *  the input `fadeIn`. */
export function tagAll<O extends Record<string, AnyAnimFactory>>(o: O): O {
  const out = {} as O;
  for (const k of Object.keys(o) as Array<keyof O & string>) {
    out[k] = tag(o[k], k) as O[keyof O & string];
  }
  return out;
}
