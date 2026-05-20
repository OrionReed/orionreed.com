// hyper.ts — N→M bidirectional reactive views (hyperLens).
//
// Generalises `combine` from N→1 to N→M. The interesting piece is
// per-output inverse policies: when output K is written, only the
// policy registered for K runs; this lets each output have its own
// "which inputs do I redistribute to" semantics.
//
// API shape:
//
//   const { center, distance } = hyperLens(
//     [f1, f2] as const,
//     // forward: inputs → outputs (typed record)
//     ([f1, f2]) => ({
//       center: midpoint(f1, f2),
//       distance: dist(f1, f2),
//     }),
//     // backward: per-output inverse policies
//     {
//       center: (newCenter, [f1, f2]) => [
//         vAdd(f1, vSub(newCenter, midpoint(f1, f2))),
//         vAdd(f2, vSub(newCenter, midpoint(f1, f2))),
//       ],
//       distance: (newD, [f1, f2]) => {
//         const mid = midpoint(f1, f2);
//         const dir = vNorm(vSub(f2, f1));
//         return [vSub(mid, vScale(dir, newD/2)), vAdd(mid, vScale(dir, newD/2))];
//       },
//     },
//   );
//
// Each output is a typed `Signal<…>`; you can read/write any of them
// independently. Writes flow back to the inputs per-output policy.
// Reads observe the entire input tuple (fan-in).
//
// Identity guarantees:
//   - The returned record's fields are stable references (memoized on
//     the hyperLens internal state).
//   - All outputs observe the same forward closure; they share dirty
//     state implicitly through the inputs.

import { Signal, lens, type Read, type ValueOf, batch } from "../signal";

/** A tuple `Ins` of Read-shapes mapped to their inner value types. */
type ValuesOf<Ins extends readonly Read<unknown>[]> = {
  readonly [K in keyof Ins]: ValueOf<Ins[K]>;
};

/** Per-output inverse policy: takes the output's new value and a
 *  snapshot of the current inputs, returns the new input tuple. */
export type InversePolicy<Outs, Ins extends readonly Read<unknown>[]> = {
  [K in keyof Outs]: (next: Outs[K], prevInputs: ValuesOf<Ins>) => ValuesOf<Ins>;
};

/** N→M reactive view.
 *
 *  - `inputs` — the N reactive parents.
 *  - `forward` — pure function: inputs → typed record of outputs.
 *  - `backward` — per-output: how to push that output's new value
 *    back to the inputs. Writes go through `batch()` so all inputs
 *    update atomically per write.
 *
 *  Returns a record of `Signal<Outs[K]>` — each output is its own
 *  reactive cell, readable and (if a policy exists for K) writable. */
export function hyperLens<
  const Ins extends readonly Read<unknown>[],
  Outs extends Record<string, unknown>,
>(
  inputs: Ins,
  forward: (vs: ValuesOf<Ins>) => Outs,
  backward: Partial<InversePolicy<Outs, Ins>>,
): { [K in keyof Outs]: Signal<Outs[K]> } {
  // Snapshot input values into a tuple shape every read; cheap.
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

  // Build one output cell per key. Read = forward(readAll())[key]; write
  // = look up policy[key], compute new inputs, batch-write back.
  //
  // We need the output keys to build the result. The cleanest way to
  // get them without a separate "shape" arg is to evaluate `forward`
  // once with peek (no tracking) to discover the keys.
  const sampleOuts = forward(peekAll());
  const keys = Object.keys(sampleOuts) as (keyof Outs)[];

  const result = {} as { [K in keyof Outs]: Signal<Outs[K]> };
  for (const k of keys) {
    const policy = backward[k];
    if (policy === undefined) {
      // Read-only output (no inverse) — use plain computed (writes throw)
      result[k] = lens<Outs[typeof k]>(
        () => forward(readAll())[k],
        () => { throw new TypeError(`hyperLens: output "${String(k)}" is read-only (no inverse policy)`); },
      ) as Signal<Outs[typeof k]>;
    } else {
      result[k] = lens<Outs[typeof k]>(
        () => forward(readAll())[k],
        (next) => {
          const prev = peekAll();
          const updated = policy(next, prev);
          batch(() => {
            for (let i = 0; i < inputs.length; i++) {
              const inp = inputs[i];
              if (inp instanceof Signal) (inp as Signal<unknown>).value = updated[i];
            }
          });
        },
      ) as Signal<Outs[typeof k]>;
    }
  }
  return result;
}
