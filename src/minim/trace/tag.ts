// Identity for traced generators. Wrap an animator factory with `tag`
// and each generator instance it produces is registered in a private
// WeakMap; the trace machinery (`spans()` in `./spans`) looks up the
// gen reference from each spawn event and reads the tag if present.
// No runtime instrumentation, no convention key on the gen object —
// the runtime knows nothing about tags, only about lifecycle events.
//
// Use at the call site, not inside the lib's primitives. Library
// recipes (`fadeIn`, `tween`, …) stay untagged so production code
// pays nothing; demos/tests tag at the top of their own files:
//
//     const t = tagAll({ fadeIn, fadeUp, fooBar });
//     anim.run(function*() {
//       yield [t.fadeIn(a, 0.3), t.fadeUp(b, 0.5)];
//     });

import type { Animator } from "../core/anim";

/** Private gen → tag table. WeakMap so dropped generators don't keep
 *  their tags alive. */
const tags = new WeakMap<Animator, string>();

type AnyAnimFactory = (...args: any[]) => Animator;

/** Wrap an animator factory so each generator it produces is tagged
 *  with `name` (or `fn.name` if omitted). The wrapper preserves the
 *  factory's call signature; types flow through. */
export function tag<F extends AnyAnimFactory>(fn: F, name?: string): F {
  const tagName = name ?? fn.name;
  return ((...args: Parameters<F>) => {
    const g = fn(...args);
    tags.set(g, tagName);
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

/** Look up a generator's tag, if any. Used internally by `spans()`. */
export function tagOf(gen: Animator): string | undefined {
  return tags.get(gen);
}
