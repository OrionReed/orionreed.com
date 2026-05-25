// network-validation.test.ts — stress-test the `network` shape by
// implementing tiny end-to-end "kernels" that exercise the design.
//
//   1. `relateOnNetwork`     — relate(a, b, fwd, bwd) on one network.
//                             Direction selection via `dirty`.
//   2. `equalitySolver`     — multi-relation, multi-signal cluster:
//                             lazy slot allocation, add/remove with
//                             `cluster.add` / `cluster.remove`,
//                             warm-state preserved across mutations.
//   3. `manualClock`        — manual-mode network as time-stepped
//                             primitive: gravity-style velocity update
//                             driven by explicit `flush(dt)`.
//
// These aren't real production kernels; they're just enough to confirm
// the surface composes cleanly and the primitive's invariants hold.

import { describe, expect, it } from "vitest";
import { each, param, type Signal, network, signal, type Writable } from "../index";

// ─── 1. `relate` rebuilt on `network` ────────────────────────────────

interface RelateHandle {
  dispose(): void;
}

function relateOnNetwork<A, B>(
  a: Writable<Signal<A>>,
  b: Writable<Signal<B>>,
  fwd: (a: A) => B,
  bwd: (b: B) => A,
): RelateHandle {
  const aSig = a;
  const bSig = b;
  // Two networks, one per direction (mirrors the existing `relate`
  // shape). Each direction self-excludes its own network; the other
  // direction's network is a separate node, so it observes the write
  // and ping-pongs as needed. Termination is structural: the second
  // round-trip's `===` short-circuit stops propagation.
  const fwdNetwork = network(_dirty => {
    bSig.value = fwd(aSig.value);
  });
  const bwdNetwork = network(_dirty => {
    aSig.value = bwd(bSig.value);
  });
  return {
    dispose() {
      fwdNetwork.dispose();
      bwdNetwork.dispose();
    },
  };
}

describe("validation: relate(a, b) rebuilt on network", () => {
  it("Iso: writes from either side propagate", () => {
    const a = signal(0);
    const b = signal(0);
    const r = relateOnNetwork(
      a,
      b,
      x => x + 100,
      y => y - 100,
    );
    expect(b.value).toBe(100); // initial fwd kick

    a.value = 5;
    expect(a.value).toBe(5);
    expect(b.value).toBe(105);

    b.value = 200;
    expect(b.value).toBe(200);
    expect(a.value).toBe(100);

    r.dispose();
  });

  it("non-Iso lossy: writes terminate via direction selection", () => {
    const a = signal(0);
    const b = signal(0);
    const r = relateOnNetwork(
      a,
      b,
      x => x * 2,
      y => Math.floor(y / 2),
    );
    a.value = 5;
    expect(b.value).toBe(10);
    b.value = 7;
    // bwd(7) = 3 → a := 3. Network re-runs (dirty: a). aHot && !bHot → b := fwd(3) = 6.
    // Network re-runs (dirty: b). bHot && !aHot → a := bwd(6) = 3.
    // a's write detects same value (3 === 3), no propagate; loop terminates.
    expect(a.value).toBe(3);
    expect(b.value).toBe(6);
    r.dispose();
  });
});

// ─── 2. Equality solver — tiny multi-relation cluster ───────────────
//
// "Equality solver": a cluster where the only relation type is
// `eq(a, b)` (a === b). Multiple `eq` relations form an equivalence
// graph; the cluster picks a representative per component each tick
// and pushes its value to all members. Demonstrates:
//   - add / remove of relations with object identity
//   - lazy member tracking (slots) via the `members` array
//   - mutable params via getter/setter (none needed for eq, but the
//     class shape is the same)

interface EqRelation {
  members: readonly Signal<unknown>[];
}

function eq(a: Signal<number>, b: Signal<number>): EqRelation {
  return { members: [a as Signal<unknown>, b as Signal<unknown>] };
}

interface EqualityCluster {
  add(r: EqRelation): EqRelation;
  remove(r: EqRelation): void;
  dispose(): void;
}

function equalityCluster(): EqualityCluster {
  const active = new Set<EqRelation>();
  const handle = network(dirty => {
    if (active.size === 0) return;

    // For each connected component, pick a representative — the
    // signal that appears in `dirty` if any (otherwise just first).
    // Simple union-find by member iteration.
    const parent = new Map<Signal<unknown>, Signal<unknown>>();
    function root(s: Signal<unknown>): Signal<unknown> {
      let p = parent.get(s) ?? s;
      while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
      parent.set(s, p);
      return p;
    }
    function unite(a: Signal<unknown>, b: Signal<unknown>) {
      const ra = root(a);
      const rb = root(b);
      if (ra !== rb) parent.set(ra, rb);
    }
    for (const r of active) {
      const [a, b] = r.members;
      unite(a!, b!);
    }
    // Group members by root.
    const groups = new Map<Signal<unknown>, Signal<unknown>[]>();
    for (const r of active) {
      for (const m of r.members) {
        const k = root(m);
        let g = groups.get(k);
        if (!g) groups.set(k, (g = []));
        if (!g.includes(m)) g.push(m);
      }
    }
    // Per group: read every member's value (subscribe), then pick
    // the dirty one as driver and overwrite the others. We MUST read
    // each member explicitly — writes don't subscribe; without an
    // explicit read, dirty tracking would never see them.
    for (const members of groups.values()) {
      const values = members.map(m => (m as Signal<number>).value);
      let driverIdx = members.findIndex(m => dirty.has(m));
      if (driverIdx === -1) driverIdx = 0;
      const v = values[driverIdx]!;
      for (let i = 0; i < members.length; i++) {
        if (i !== driverIdx && values[i] !== v) {
          (members[i] as Writable<Signal<number>>).value = v;
        }
      }
    }
  });

  return {
    add(r) {
      active.add(r);
      handle.flush(); // re-run with the new relation
      return r;
    },
    remove(r) {
      active.delete(r);
      handle.flush();
    },
    dispose: handle.dispose,
  };
}

describe("validation: equality cluster (multi-relation)", () => {
  it("transitive equalities propagate values across the component", () => {
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    const cluster = equalityCluster();
    cluster.add(eq(a, b));
    cluster.add(eq(b, c));

    a.value = 7;
    expect(b.value).toBe(7);
    expect(c.value).toBe(7);

    c.value = 42;
    expect(a.value).toBe(42);
    expect(b.value).toBe(42);

    cluster.dispose();
  });

  it("removing a relation breaks the equivalence", () => {
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    const cluster = equalityCluster();
    const ab = cluster.add(eq(a, b));
    const bc = cluster.add(eq(b, c));

    a.value = 5;
    expect(c.value).toBe(5);

    cluster.remove(bc);

    // a, b still tied; c is now independent.
    a.value = 10;
    expect(b.value).toBe(10);
    expect(c.value).toBe(5);

    cluster.dispose();
    void ab;
  });

  it("dispose stops re-firing on member changes", () => {
    const a = signal(0);
    const b = signal(0);
    const cluster = equalityCluster();
    cluster.add(eq(a, b));
    a.value = 1;
    expect(b.value).toBe(1);
    cluster.dispose();
    a.value = 99;
    expect(b.value).toBe(1); // not 99 — disposed
  });

  it("integrates with `each` for reactive collections of relations", () => {
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    type Edge = { from: Signal<number>; to: Signal<number> };
    const e1: Edge = { from: a, to: b };
    const edges = signal<Edge[]>([e1]);
    const cluster = equalityCluster();
    each(edges, edge => {
      const r = cluster.add(eq(edge.from, edge.to));
      return () => cluster.remove(r);
    });

    a.value = 1;
    expect(b.value).toBe(1);
    expect(c.value).toBe(0); // c isn't connected yet

    // Add b ↔ c.
    const e2: Edge = { from: b, to: c };
    edges.value = [e1, e2];
    a.value = 5;
    expect(b.value).toBe(5);
    expect(c.value).toBe(5);

    // Remove a ↔ b.
    edges.value = [e2];
    a.value = 99;
    expect(b.value).toBe(5); // disconnected
    expect(c.value).toBe(5);

    cluster.dispose();
  });
});

// ─── 3. Manual-mode network as a time-driven step loop ───────────────

describe("validation: manual-mode network as time-stepped primitive", () => {
  it("velocity-update style: dep changes don't fire until step()", () => {
    const x = signal(0);
    const v = signal(10); // velocity
    let stepCount = 0;
    const handle = network(
      _dirty => {
        // Apply velocity; pretend dt=1.
        const cur = x.value;
        const vel = v.value;
        x.value = cur + vel;
        stepCount++;
      },
      { manual: true },
    );
    expect(stepCount).toBe(1);
    expect(x.value).toBe(10); // initial step ran

    // Mutating velocity does NOT trigger another step.
    v.value = 5;
    v.value = 8;
    v.value = 3;
    expect(stepCount).toBe(1);
    expect(x.value).toBe(10);

    // Explicit step.
    handle.flush();
    expect(stepCount).toBe(2);
    expect(x.value).toBe(13); // 10 + 3

    handle.flush();
    expect(stepCount).toBe(3);
    expect(x.value).toBe(16); // 13 + 3
    // Note: x was written by body; it doesn't re-fire body (self-exclusion).

    handle.dispose();
  });

  it("manual network composes with auto network: time loop drives reactivity", () => {
    const x = signal(0);
    const observed: number[] = [];
    // Auto-mode network observes x, mirrors to a side channel.
    const mirror = signal(0);
    const auto = network(_dirty => {
      mirror.value = x.value * 2;
    });
    // Effect on the side channel.
    const side: number[] = [];
    const _autoEff = network(_dirty => {
      side.push(mirror.value);
    });

    let dt = 1;
    const v = signal(3);
    const sim = network(
      _dirty => {
        x.value = x.value + v.value * dt;
        observed.push(x.value);
      },
      { manual: true },
    );

    expect(observed).toEqual([3]);
    expect(side[side.length - 1]).toBe(6); // 3 * 2

    dt = 2;
    sim.flush();
    expect(x.value).toBe(9); // 3 + 3*2
    expect(side[side.length - 1]).toBe(18);

    sim.dispose();
    auto.dispose();
    _autoEff.dispose();
  });
});

// ─── 4. param() composing in a fake-AVBD ────────────────────────────
//
// Demonstrates that a relation-shaped class with mutable params
// (Signal-backed) works under network: mutating `dist.distance`
// re-fires the cluster without a structural rebuild.

class MockDistance {
  readonly members: readonly Signal<unknown>[];
  private readonly _d: Writable<Signal<number>>;

  constructor(a: Signal<number>, b: Signal<number>, d: number | Writable<Signal<number>>) {
    this.members = [a as Signal<unknown>, b as Signal<unknown>];
    this._d = param(d);
  }

  get distance(): number {
    return this._d.value;
  }

  set distance(v: number) {
    this._d.value = v;
  }

  /** Compute "force" (just returns the signed distance error here). */
  residual(): number {
    const a = (this.members[0] as Signal<number>).value;
    const b = (this.members[1] as Signal<number>).value;
    return b - a - this._d.value;
  }
}

describe("validation: relation with mutable params via param()", () => {
  it("param accepts plain number and exposes mutation via setter", () => {
    const a = signal(0);
    const b = signal(0);
    const d = new MockDistance(a, b, 10);
    expect(d.distance).toBe(10);
    d.distance = 25;
    expect(d.distance).toBe(25);
  });

  it("param accepts a signal and shares mutations bidirectionally", () => {
    const a = signal(0);
    const b = signal(0);
    const lengthSig = signal(50);
    const d = new MockDistance(a, b, lengthSig);
    expect(d.distance).toBe(50);
    lengthSig.value = 99;
    expect(d.distance).toBe(99);
    d.distance = 7;
    expect(lengthSig.value).toBe(7); // shared via param's same-ref return
  });

  it("a network body reading the param re-fires when it changes", () => {
    const a = signal(0);
    const b = signal(10);
    const d = new MockDistance(a, b, 10);
    let lastResidual: number | undefined;
    const handle = network(_dirty => {
      lastResidual = d.residual();
    });
    expect(lastResidual).toBe(0); // 10 - 0 - 10
    d.distance = 5;
    expect(lastResidual).toBe(5); // 10 - 0 - 5
    a.value = 3;
    expect(lastResidual).toBe(2); // 10 - 3 - 5
    handle.dispose();
  });
});
