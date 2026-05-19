// Tag a generator factory so each spawned instance is identifiable in traces.

import {Animator, isGen, type Yieldable} from "@minim/core";

/** Gen → tag table. WeakMap so dropped generators are collectable. */
const tags = new WeakMap<Animator, string>();

type AnyAnimFactory = (...args: any[]) => Yieldable;

/** Recursively tag every Animator inside a Yieldable. Arrays (multi-axis
 *  transitions) get each member tagged; bare generators are tagged
 *  directly; other Yieldables (numbers / suspends / undefined) are
 *  untaggable and silently skipped — they have no identity to attach to. */
function tagYieldable(y: Yieldable, name: string): void {
  if (isGen(y)) tags.set(y, name);
  else if (Array.isArray(y)) for (const k of y) tagYieldable(k, name);
}

/** Wrap a factory so the generators it produces are tagged with `name`
 *  (or `fn.name`). Recurses into Yieldable arrays so multi-axis
 *  transitions get every constituent tween tagged. */
export function tag<F extends AnyAnimFactory>(fn: F, name?: string): F {
  const tagName = name ?? fn.name;
  return ((...args: Parameters<F>) => {
    const g = fn(...args);
    tagYieldable(g, tagName);
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
