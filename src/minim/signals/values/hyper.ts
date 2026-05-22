// hyper.ts — N→M bidirectional reactive views (hyperLens).
//
// Generalises `combine` from N→1 to N→M. The interesting piece is
// per-output inverse policies: when output K is written, only the
// policy registered for K runs; this lets each output have its own
// "which inputs do I redistribute to" semantics.

import { batch, lens, type Of, type Read, Signal, type WritableBrand } from "../signal";

type ValuesOf<Ins extends readonly Read<unknown>[]> = {
  readonly [K in keyof Ins]: Of<Ins[K]>;
};

/** Per-output inverse policy: takes the output's new value and a
 *  snapshot of the current inputs, returns the new input tuple. */
export type InversePolicy<Outs, Ins extends readonly Read<unknown>[]> = {
  [K in keyof Outs]: (next: Outs[K], prevInputs: ValuesOf<Ins>) => ValuesOf<Ins>;
};

/** N→M reactive view. Outputs with a backward policy are writable
 *  (return type includes `WritableBrand`); outputs without are RO
 *  Signal<Outs[K]>. */
export function hyperLens<
  const Ins extends readonly Read<unknown>[],
  Outs extends Record<string, unknown>,
  Back extends Partial<InversePolicy<Outs, Ins>>,
>(
  inputs: Ins,
  forward: (vs: ValuesOf<Ins>) => Outs,
  backward: Back,
): {
  [K in keyof Outs]: K extends keyof Back
    ? Back[K] extends undefined
      ? Signal<Outs[K]>
      : Signal<Outs[K]> & WritableBrand
    : Signal<Outs[K]>;
} {
  const readAll = (): ValuesOf<Ins> => {
    const out = new Array<unknown>(inputs.length);
    for (let i = 0; i < inputs.length; i++) out[i] = inputs[i].value;
    return out as unknown as ValuesOf<Ins>;
  };
  const peekAll = (): ValuesOf<Ins> => {
    const out = new Array<unknown>(inputs.length);
    for (let i = 0; i < inputs.length; i++) out[i] = inputs[i].peek();
    return out as unknown as ValuesOf<Ins>;
  };

  // Discover output keys by sampling forward once (untracked).
  const sampleOuts = forward(peekAll());
  const keys = Object.keys(sampleOuts) as (keyof Outs)[];

  const result: Record<string, unknown> = {};
  for (const k of keys) {
    const policy = backward[k as keyof Back];
    if (policy === undefined) {
      result[k as string] = lens<Outs[typeof k]>(
        () => forward(readAll())[k],
        () => {
          throw new TypeError(`hyperLens: output "${String(k)}" is read-only (no inverse policy)`);
        },
      );
    } else {
      result[k as string] = lens<Outs[typeof k]>(
        () => forward(readAll())[k],
        next => {
          const prev = peekAll();
          const updated = (policy as InversePolicy<Outs, Ins>[keyof Outs])(next, prev);
          batch(() => {
            for (let i = 0; i < inputs.length; i++) {
              const inp = inputs[i];
              if (inp instanceof Signal) (inp as Signal<unknown>).value = updated[i];
            }
          });
        },
      );
    }
  }
  return result as never;
}
