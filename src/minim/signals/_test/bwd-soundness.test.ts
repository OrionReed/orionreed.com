// Backward-propagation soundness spec.
//
// The law under test: writing a reachable target to a PutGet ("well-
// behaved") lens must read back exactly that target — across ANY DAG
// topology, including lenses whose `fwd` reads derived values that depend
// on the source the `bwd` writes. A violation is a silently LOST WRITE.
//
// This is the executable definition the backward engine must satisfy. It
// caught the makeAnchor class of bug (engine speculatively predicting the
// post-write view from a stale candidate); it must stay at zero failures.

import { describe, expect, it } from "vitest";
import { cell, derive, lens } from "../index";

// ── seeded PRNG (mulberry32) ─────────────────────────────────────────
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

type N = { value: number; peek(): number };

function derivedMirror(src: N, depth: number): N {
  let cur = src;
  for (let i = 0; i < depth; i++) {
    const p = cur;
    cur = derive([p] as unknown as readonly [N], ([x]: readonly number[]) => x) as unknown as N;
  }
  return cur;
}

describe("backward soundness: targeted breakers", () => {
  it("multi-parent lens whose fwd reads an UNDECLARED derived node (depth 1)", () => {
    const base = cell(10);
    const S = cell(5);
    const D = derive([S] as const, ([s]) => s);
    const L = lens(
      [base, S] as const,
      ([b]) => b + D.value,
      (t, [b]) => [undefined, t - b],
    );
    expect(L.value).toBe(15);
    L.value = 30;
    expect(S.peek()).toBe(20);
    expect(L.value).toBe(30);
  });

  it("undeclared read of a DEEP derived chain (depth 3)", () => {
    const base = cell(0);
    const S = cell(1);
    const d3 = derivedMirror(S, 3); // == S
    const L = lens(
      [base, S] as const,
      ([b]) => b + d3.value,
      (t, [b]) => [undefined, t - b],
    );
    expect(L.value).toBe(1);
    L.value = 9;
    expect(S.peek()).toBe(9);
    expect(L.value).toBe(9);
  });
});

describe("backward soundness: PutGet fuzz over random anchor-style DAGs", () => {
  it("zero lost writes across all topologies", () => {
    const N = 4000;
    const r = rng(0xc0ffee);
    let fails = 0;
    const firstFail: string[] = [];

    for (let iter = 0; iter < N; iter++) {
      const m = int(r, 1, 3);
      const sources: N[] = [];
      for (let i = 0; i < m; i++) sources.push(cell(int(r, -5, 5)) as unknown as N);

      // read terms (coef +1); at least one depends on the written source 0.
      interface Term {
        node: N;
        srcIdx: number;
        declared: boolean;
        readVia: "param" | "closure";
      }
      const terms: Term[] = [];
      const nTerms = int(r, 1, 4);
      for (let k = 0; k <= nTerms; k++) {
        const srcIdx = k === 0 ? 0 : int(r, 0, m - 1);
        const derived = r() < 0.5;
        const node = derived ? derivedMirror(sources[srcIdx]!, int(r, 1, 3)) : sources[srcIdx]!;
        const declared = derived ? r() < 0.5 : r() < 0.6;
        const readVia: "param" | "closure" = !declared
          ? "closure"
          : derived
            ? "closure"
            : r() < 0.5
              ? "param"
              : "closure";
        terms.push({ node, srcIdx, declared, readVia });
      }

      const parents: N[] = [sources[0]!];
      const paramIndexOf = new Map<N, number>();
      paramIndexOf.set(sources[0]!, 0);
      for (const t of terms) {
        if (t.declared && !paramIndexOf.has(t.node)) {
          paramIndexOf.set(t.node, parents.length);
          parents.push(t.node);
        }
      }

      const viewOf = (): number => terms.reduce((acc, t) => acc + t.node.peek(), 0);
      const gamma = terms.filter(t => t.srcIdx === 0).length;

      const fwd = (vals: number[]): number =>
        terms.reduce((acc, t) => {
          const idx = paramIndexOf.get(t.node);
          const v = t.readVia === "param" && idx !== undefined ? vals[idx]! : t.node.value;
          return acc + v;
        }, 0);

      const bwd = (target: number): (number | undefined)[] => {
        const cur = viewOf();
        const s0 = sources[0]!.peek();
        const updates: (number | undefined)[] = new Array(parents.length).fill(undefined);
        updates[0] = s0 + (target - cur) / gamma;
        return updates;
      };

      const L = lens(
        parents as unknown as readonly N[],
        fwd as unknown as (vals: readonly number[]) => number,
        bwd as unknown as (t: number, vals: readonly number[]) => readonly (number | undefined)[],
      ) as unknown as N;

      const cur = L.value;
      const k = int(r, -4, 4);
      const target = cur + gamma * k;
      let held: boolean;
      try {
        L.value = target;
        held = L.value === target;
      } catch {
        held = false;
      }
      if (!held) {
        fails++;
        if (firstFail.length < 1) {
          firstFail.push(
            `iter=${iter} m=${m} terms=${terms.length} gamma=${gamma} target=${target}`,
          );
        }
      }
    }

    expect({ fails, firstFail }).toEqual({ fails: 0, firstFail: [] });
  });
});
