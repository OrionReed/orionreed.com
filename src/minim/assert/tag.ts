// Tag a generator factory so each instance is tagged for the trace
// machinery. Use at the call site (not inside library primitives) so
// production stays untagged.
//
//     const t = tagAll({ fadeIn, fadeUp });
//     anim.start(function*() {
//       yield [t.fadeIn(a, 0.3), t.fadeUp(b, 0.5)];
//     });

import { Animator } from "@minim/core";

/** Gen → tag table. WeakMap so dropped generators are collectable. */
const tags = new WeakMap<Animator, string>();

type AnyAnimFactory = (...args: any[]) => Animator;

/** Wrap a factory so each generator it produces is tagged with `name`
 *  (or `fn.name`). Types flow through. */
export function tag<F extends AnyAnimFactory>(fn: F, name?: string): F {
  const tagName = name ?? fn.name;
  return ((...args: Parameters<F>) => {
    const g = fn(...args);
    tags.set(g, tagName);
    return g;
  }) as F;
}

/** Batch-tag a record of factories — keys become the tags. */
export function tagAll<O extends Record<string, AnyAnimFactory>>(o: O): O {
  const out = {} as O;
  for (const k of Object.keys(o) as Array<keyof O & string>) {
    out[k] = tag(o[k], k) as O[keyof O & string];
  }
  return out;
}

export function tagOf(gen: Animator): string | undefined {
  return tags.get(gen);
}
