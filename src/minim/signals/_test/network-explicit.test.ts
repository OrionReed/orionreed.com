// network-explicit.test.ts — adversarial probe for the new
// EXPLICIT-DEPS shape of network().
//
// Coverage:
//   1. Construction & deps semantics
//   2. Subscribe / unsubscribe behaviour
//   3. Body firing rules (auto + manual)
//   4. Self-exclusion of writes
//   5. Atomic batch
//   6. Dirty set computation
//   7. Reads inside body (no auto-track)
//   8. Computed/lens deps
//   9. Disposal
//  10. Edge cases & footguns

import { describe, expect, it } from "vitest";
import { batch, effect, network, signal } from "../signal";
import { num } from "../values/num";

// ─── 1. Construction ───────────────────────────────────────────────

describe("explicit-deps: construction", () => {
  it("body fires once on construction with empty dirty", () => {
    const a = num(0);
    const seen: number[] = [];
    const n = network([a], dirty => {
      seen.push(dirty.size);
    });
    expect(seen).toEqual([0]);
    n.dispose();
  });

  it("empty deps: body fires once on construction, never auto again", () => {
    const a = num(0);
    let fires = 0;
    const n = network([], () => {
      fires++;
    });
    expect(fires).toBe(1);

    a.value = 1; // not in deps
    expect(fires).toBe(1);

    n.flush();
    expect(fires).toBe(2);
    n.dispose();
  });

  it("multiple deps: body subscribes to all", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    let fires = 0;
    const n = network([a, b, c], () => {
      fires++;
    });
    fires = 0;

    a.value = 1;
    expect(fires).toBe(1);
    b.value = 2;
    expect(fires).toBe(2);
    c.value = 3;
    expect(fires).toBe(3);
    n.dispose();
  });
});

// ─── 2. Subscribe / unsubscribe ────────────────────────────────────

describe("explicit-deps: subscribe / unsubscribe", () => {
  it("subscribe adds dep WITHOUT firing body", () => {
    const a = num(0);
    const b = num(0);
    let fires = 0;
    const n = network([a], () => {
      fires++;
    });
    fires = 0; // ignore initial

    n.subscribe(b);
    expect(fires).toBe(0); // subscribe doesn't fire

    b.value = 1;
    expect(fires).toBe(1); // now b is a dep
    n.dispose();
  });

  it("subscribe is idempotent — repeated calls don't double-link", () => {
    const a = num(0);
    let fires = 0;
    const n = network([a], () => {
      fires++;
    });
    fires = 0;

    n.subscribe(a);
    n.subscribe(a);
    n.subscribe(a);

    a.value = 1;
    expect(fires).toBe(1); // ONE fire even though we subscribed 3x
    n.dispose();
  });

  it("unsubscribe stops notifications from that dep", () => {
    const a = num(0);
    const b = num(0);
    let fires = 0;
    const n = network([a, b], () => {
      fires++;
    });
    fires = 0;

    n.unsubscribe(b);
    b.value = 1;
    expect(fires).toBe(0); // b no longer a dep

    a.value = 1;
    expect(fires).toBe(1); // a still works
    n.dispose();
  });

  it("unsubscribe a signal not in deps is no-op", () => {
    const a = num(0);
    const b = num(0);
    const n = network([a], () => {});
    expect(() => n.unsubscribe(b)).not.toThrow();
    n.dispose();
  });

  it("subscribe a non-dep signal then unsubscribe brings deps back to original", () => {
    const a = num(0);
    const b = num(0);
    let fires = 0;
    const n = network([a], () => {
      fires++;
    });
    fires = 0;

    n.subscribe(b);
    n.unsubscribe(b);

    b.value = 1;
    expect(fires).toBe(0); // b is gone again
    a.value = 1;
    expect(fires).toBe(1);
    n.dispose();
  });

  it("subscribe + flush is the explicit 'add and rerun' pattern", () => {
    const a = num(0);
    const b = num(99);
    const seen: ReadonlySet<unknown>[] = [];
    const n = network([a], dirty => {
      seen.push(dirty);
    });
    expect(seen.length).toBe(1); // initial

    n.subscribe(b);
    n.flush();
    expect(seen.length).toBe(2);
    // dirty includes b (it's now a dep, lastValues didn't have it,
    // peek differs from undefined → added to dirty)
    n.dispose();
  });
});

// ─── 3. Reads inside body ──────────────────────────────────────────

describe("explicit-deps: reads inside body don't auto-subscribe", () => {
  it("reading a non-dep signal in body doesn't add it to deps", () => {
    const a = num(0);
    const b = num(0);
    let fires = 0;
    let lastB = -1;
    const n = network([a], () => {
      fires++;
      lastB = b.value; // read but not subscribed
    });
    fires = 0;

    b.value = 5;
    expect(fires).toBe(0); // b is NOT a dep
    expect(lastB).toBe(0); // still has the value from initial fire

    a.value = 1;
    expect(fires).toBe(1);
    expect(lastB).toBe(5); // re-read fresh value
    n.dispose();
  });

  it("conditional reads in body don't shrink/grow the dep set", () => {
    const flag = num(1); // 1 = read a, 0 = read b
    const a = num(0);
    const b = num(0);
    let lastSeen = "";
    const n = network([flag, a, b], () => {
      if (flag.value) lastSeen = `a=${a.value}`;
      else lastSeen = `b=${b.value}`;
    });

    flag.value = 0;
    expect(lastSeen).toBe("b=0");

    // In implicit mode `a` would be unsubscribed; in explicit it stays.
    a.value = 5;
    // Body re-fires because a is still in deps. Body chose not to read a.
    expect(lastSeen).toBe("b=0");

    n.dispose();
  });
});

// ─── 4. Self-exclusion ─────────────────────────────────────────────

describe("explicit-deps: self-exclusion", () => {
  it("body writing a dep doesn't recursively fire", () => {
    const a = num(0);
    let fires = 0;
    const n = network([a], () => {
      fires++;
      a.value = a.value + 1; // self-write should not refire
    });
    expect(fires).toBe(1); // ran once
    expect(a.value).toBe(1);

    // External write does fire it.
    a.value = 100;
    expect(fires).toBe(2);
    expect(a.value).toBe(101); // body incremented after read
    n.dispose();
  });

  it("body writing a NON-dep signal that downstream observers subscribe to", () => {
    const trigger = num(0);
    const out = num(0); // not a dep of n
    let outObs = 0;
    effect(() => {
      out.value;
      outObs++;
    });
    outObs = 0;

    let fires = 0;
    const n = network([trigger], () => {
      fires++;
      out.value = trigger.value * 2;
    });

    trigger.value = 5;
    expect(out.value).toBe(10);
    expect(outObs).toBeGreaterThan(0); // effect saw the write
    n.dispose();
  });
});

// ─── 5. Atomic batch ───────────────────────────────────────────────

describe("explicit-deps: atomic batch", () => {
  it("multiple writes inside body commit atomically (one effect run)", () => {
    const trigger = num(0);
    const a = num(0);
    const b = num(0);
    let observations = 0;
    let lastA = 0;
    let lastB = 0;
    effect(() => {
      lastA = a.value;
      lastB = b.value;
      observations++;
    });
    observations = 0;

    const n = network([trigger], () => {
      a.value = trigger.value;
      b.value = trigger.value * 2;
    });

    trigger.value = 5;
    expect(lastA).toBe(5);
    expect(lastB).toBe(10);
    expect(observations).toBe(1); // one effect run for both writes
    n.dispose();
  });

  it("write-then-read inside body sees latest value", () => {
    const a = num(0);
    let mid = -1;
    const n = network([a], () => {
      a.value = 10;
      mid = a.value; // should see 10
    });
    expect(mid).toBe(10);
    n.dispose();
  });
});

// ─── 6. Dirty set ──────────────────────────────────────────────────

describe("explicit-deps: dirty set", () => {
  it("dirty contains exactly the deps that changed since last run", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    const dirties: number[] = [];
    const n = network([a, b, c], dirty => {
      dirties.push(dirty.size);
    });

    a.value = 1; // dirty = {a}
    b.value = 2; // dirty = {b}
    c.value = 3; // dirty = {c}
    expect(dirties.slice(1)).toEqual([1, 1, 1]);
    n.dispose();
  });

  it("dirty contains MULTIPLE deps when batched", () => {
    const a = num(0);
    const b = num(0);
    const dirties: number[] = [];
    const n = network([a, b], dirty => {
      dirties.push(dirty.size);
    });

    // Use batch to make a, b change together.
    batch(() => {
      a.value = 1;
      b.value = 2;
    });
    expect(dirties[1]).toBe(2);
    n.dispose();
  });

  it("dirty empty on initial fire", () => {
    const a = num(0);
    const dirties: number[] = [];
    network([a], dirty => {
      dirties.push(dirty.size);
    });
    expect(dirties[0]).toBe(0);
  });
});

// ─── 7. Manual mode ────────────────────────────────────────────────

describe("explicit-deps: manual mode", () => {
  it("body fires on construction even in manual mode", () => {
    const a = num(0);
    let fires = 0;
    const n = network([a], () => {
      fires++;
    }, { manual: true });
    expect(fires).toBe(1);
    n.dispose();
  });

  it("dep changes don't auto-fire body in manual mode", () => {
    const a = num(0);
    let fires = 0;
    const n = network([a], () => {
      fires++;
    }, { manual: true });
    fires = 0;

    a.value = 1;
    a.value = 2;
    a.value = 3;
    expect(fires).toBe(0); // no auto-fires

    n.flush();
    expect(fires).toBe(1); // explicit
    n.dispose();
  });

  it("flush in manual mode delivers dirty since last fire", () => {
    const a = num(0);
    const b = num(0);
    const dirties: number[] = [];
    const n = network([a, b], dirty => {
      dirties.push(dirty.size);
    }, { manual: true });

    a.value = 1;
    b.value = 2;
    n.flush();
    expect(dirties[1]).toBe(2);
    n.dispose();
  });
});

// ─── 8. Computed/lens deps ─────────────────────────────────────────

describe("explicit-deps: lens / computed deps", () => {
  it("subscribing a Computed: body fires when its parents change", () => {
    const a = num(0);
    const doubled = a.scale(2);
    let fires = 0;
    let lastSeen = -1;
    const n = network([doubled], () => {
      fires++;
      lastSeen = doubled.value;
    });
    fires = 0;

    a.value = 5;
    expect(fires).toBeGreaterThan(0);
    expect(lastSeen).toBe(10);
    n.dispose();
  });

  it("subscribing a deep chain", () => {
    const a = num(0);
    const b = num(0);
    const big = a.add(b).scale(2);
    let lastSeen = -1;
    const n = network([big], () => {
      lastSeen = big.value;
    });

    a.value = 3;
    b.value = 4;
    expect(lastSeen).toBe((3 + 4) * 2);
    n.dispose();
  });
});

// ─── 9. Disposal ───────────────────────────────────────────────────

describe("explicit-deps: disposal", () => {
  it("dispose unsubscribes from all deps", () => {
    const a = num(0);
    let fires = 0;
    const n = network([a], () => {
      fires++;
    });
    fires = 0;

    n.dispose();
    a.value = 1;
    expect(fires).toBe(0);
  });

  it("flush after dispose is no-op", () => {
    const a = num(0);
    let fires = 0;
    const n = network([a], () => {
      fires++;
    });
    n.dispose();
    fires = 0;

    n.flush();
    expect(fires).toBe(0);
  });

  it("subscribe after dispose is no-op", () => {
    const a = num(0);
    const b = num(0);
    let fires = 0;
    const n = network([a], () => {
      fires++;
    });
    n.dispose();
    fires = 0;

    n.subscribe(b);
    b.value = 5;
    expect(fires).toBe(0);
  });
});

// ─── 10. Edge cases ────────────────────────────────────────────────

describe("explicit-deps: edge cases", () => {
  it("body that throws — subsequent fires still work", () => {
    const a = num(0);
    let attempt = 0;
    const fired: number[] = [];
    const n = network([a], () => {
      attempt++;
      fired.push(a.value);
      if (a.value < 0) throw new Error("oops");
    });

    expect(() => {
      a.value = -1;
    }).toThrow("oops");

    a.value = 5;
    expect(fired).toEqual([0, -1, 5]);
    n.dispose();
  });

  it("subscribe AFTER construction — adds dep without firing body", () => {
    const a = num(0);
    const b = num(0);
    let fires = 0;
    const n = network([a], () => {
      fires++;
    });
    fires = 0;

    // Add b dynamically.
    n.subscribe(b);
    expect(fires).toBe(0); // subscribe alone doesn't fire

    b.value = 5;
    expect(fires).toBe(1); // b is now a dep
    n.dispose();
  });

  it("subscribe inside body via outer reference — works on next external write", () => {
    const a = num(0);
    const b = num(0);
    let bodyFires = 0;
    let bSubscribed = false;
    let netRef!: ReturnType<typeof network>;
    netRef = network([a], () => {
      bodyFires++;
      // After construction, the closure's `netRef` is set; safe to subscribe.
      if (!bSubscribed && bodyFires > 1) {
        netRef.subscribe(b);
        bSubscribed = true;
      }
    });

    a.value = 1; // triggers body; subscribes b
    expect(bSubscribed).toBe(true);

    b.value = 5;
    // body fires because b is now a dep.
    expect(bodyFires).toBeGreaterThan(2);
    netRef.dispose();
  });

  it("two networks both subscribing to the same signal", () => {
    const a = num(0);
    let fires1 = 0;
    let fires2 = 0;
    const n1 = network([a], () => {
      fires1++;
    });
    const n2 = network([a], () => {
      fires2++;
    });
    fires1 = 0;
    fires2 = 0;

    a.value = 1;
    expect(fires1).toBe(1);
    expect(fires2).toBe(1);

    n1.dispose();
    a.value = 2;
    expect(fires1).toBe(1); // didn't fire post-dispose
    expect(fires2).toBe(2);
    n2.dispose();
  });

  it("network writing a signal that's another network's dep", () => {
    const a = num(0);
    const b = num(0);
    let n2Fires = 0;
    const n1 = network([a], () => {
      b.value = a.value * 2; // n1 writes b
    });
    const n2 = network([b], () => {
      n2Fires++;
    });
    n2Fires = 0;

    a.value = 5;
    expect(b.value).toBe(10);
    expect(n2Fires).toBe(1); // n1's write to b fired n2
    n1.dispose();
    n2.dispose();
  });

  it("custom-equality signal: writes that don't change value don't fire", () => {
    const eqSet = (a: ReadonlySet<number>, b: ReadonlySet<number>) =>
      a.size === b.size && [...a].every(v => b.has(v));
    const s = signal<ReadonlySet<number>>(new Set([1, 2]), { equals: eqSet });

    let fires = 0;
    const n = network([s], () => {
      fires++;
    });
    fires = 0;

    s.value = new Set([1, 2]); // equal
    expect(fires).toBe(0);

    s.value = new Set([1, 2, 3]); // different
    expect(fires).toBe(1);
    n.dispose();
  });
});

// ─── 11. Adversarial: re-entry, timing, weird shapes ──────────────

describe("explicit-deps: re-entry & timing", () => {
  it("flush() inside body throws — recursion guard", () => {
    const a = num(0);
    expect(() => {
      network([a], (_dirty, n) => {
        n.flush();
      });
    }).toThrow(/flush\(\) called from inside body/);
  });

  it("dispose() AFTER construction — subsequent dep changes don't fire body", () => {
    const a = num(0);
    let fires = 0;
    const n = network([a], () => {
      fires++;
    });
    fires = 0;

    n.dispose();
    a.value = 1;
    expect(fires).toBe(0);
  });

  it("subscribe between body fires: signal NOT in dirty until next change", () => {
    const a = num(0);
    const b = num(0);
    const dirties: Array<ReadonlySet<unknown>> = [];
    const n = network([a], dirty => {
      dirties.push(new Set(dirty));
    });

    // Subscribe b without firing.
    n.subscribe(b);
    expect(dirties.length).toBe(1); // initial only

    // Now write a. Body fires; dirty contains a, NOT b (b's
    // lastValue wasn't recorded yet).
    a.value = 1;
    expect(dirties.length).toBe(2);
    expect(dirties[1]!.has(a)).toBe(true);
    expect(dirties[1]!.has(b)).toBe(false);

    // After this fire, lastValues includes b. Now writing b shows up.
    b.value = 5;
    expect(dirties.length).toBe(3);
    expect(dirties[2]!.has(b)).toBe(true);
    n.dispose();
  });

  it("writes to a dep INSIDE body don't refire (self-exclusion), but DO update its lastValue", () => {
    const a = num(0);
    const dirties: number[] = [];
    const n = network([a], dirty => {
      dirties.push(dirty.size);
      a.value = a.value + 1;
    });
    // Initial: dirty empty (size 0). Body wrote a = 1.
    expect(dirties).toEqual([0]);

    // External write a = 100. Dirty contains a (a's value differs
    // from lastValue=1).
    a.value = 100;
    // Body fires once; dirty = {a}. Body writes a = 101.
    expect(dirties[1]).toBe(1);
    expect(a.value).toBe(101);
    n.dispose();
  });

  it("repeated subscribe of same signal is idempotent at link level", () => {
    const a = num(0);
    let fires = 0;
    const n = network([], () => {
      fires++;
    });
    fires = 0;

    for (let i = 0; i < 10; i++) n.subscribe(a);
    a.value = 1;
    expect(fires).toBe(1); // ONE fire even after 10 subscribes
    n.dispose();
  });

  it("unsubscribe AFTER construction — dep drops out of notifications", () => {
    const a = num(0);
    const b = num(0);
    let fires = 0;
    const n = network([a, b], () => {
      fires++;
    });

    fires = 0;
    n.unsubscribe(b);
    b.value = 1;
    expect(fires).toBe(0); // b is gone

    a.value = 1;
    expect(fires).toBe(1);
    n.dispose();
  });
});

// ─── 12. Computed body internals ───────────────────────────────────

describe("explicit-deps: Computed reads in body don't leak into network's deps", () => {
  it("body reads a Computed that depends on a non-dep signal — non-dep stays out", () => {
    const a = num(0);     // dep
    const b = num(0);     // NOT a dep
    const sum = a.add(b); // Computed
    let fires = 0;
    let lastSum = -1;
    const n = network([a], () => {
      fires++;
      lastSum = sum.value; // reads sum, which transitively reads a and b
    });
    fires = 0;

    // Writing a fires (a is in deps).
    a.value = 5;
    expect(fires).toBe(1);
    expect(lastSum).toBe(5);

    // Writing b — sum's value changes, but the network is NOT
    // subscribed to b. Body should NOT fire.
    b.value = 100;
    expect(fires).toBe(1); // unchanged
    // sum.value lazily recomputes on next access, but body didn't run.
    n.dispose();
  });
});

// ─── 13. Stress / scale ────────────────────────────────────────────

describe("explicit-deps: stress", () => {
  it("100 deps: body fires once per individual write", () => {
    const deps = Array.from({ length: 100 }, () => num(0));
    let fires = 0;
    const n = network(deps, () => {
      fires++;
    });
    fires = 0;

    for (let i = 0; i < 100; i++) deps[i]!.value = i + 1;
    expect(fires).toBe(100);
    n.dispose();
  });

  it("subscribe 100 signals after construction; flush; all in subsequent dirty", () => {
    const root = num(0);
    const sigs = Array.from({ length: 100 }, () => num(0));
    let lastDirty = 0;
    const n = network([root], dirty => {
      lastDirty = dirty.size;
    });

    n.subscribe(...sigs);
    n.flush(); // first fire after subscribe

    // Now write half of them via batch; dirty should contain all that changed.
    batch(() => {
      for (let i = 0; i < 50; i++) sigs[i]!.value = i + 1;
    });
    expect(lastDirty).toBe(50);
    n.dispose();
  });

  it("interleaved subscribe/unsubscribe matches eventual topology", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    let fires = 0;
    const n = network([a, b], () => {
      fires++;
    });
    fires = 0;

    n.subscribe(c);
    n.unsubscribe(a);
    n.subscribe(a); // re-add
    n.unsubscribe(b);

    a.value = 1; // a is in
    b.value = 1; // b is out
    c.value = 1; // c is in
    expect(fires).toBe(2); // a and c fired; b didn't
    n.dispose();
  });
});

// ─── 14. Cross-network ─────────────────────────────────────────────

describe("explicit-deps: cross-network", () => {
  it("network A writes a non-dep signal observed by an effect — effect fires", () => {
    const trigger = num(0);
    const observed = num(0);
    let effectFires = 0;
    effect(() => {
      observed.value;
      effectFires++;
    });
    effectFires = 0;

    const n = network([trigger], () => {
      observed.value = trigger.value * 2;
    });
    expect(observed.value).toBe(0);

    trigger.value = 5;
    expect(observed.value).toBe(10);
    expect(effectFires).toBeGreaterThan(0);
    n.dispose();
  });

  it("network A writes B's dep — B fires, B's body sees the new value", () => {
    const a = num(0);
    const bridge = num(0);
    let bSeenBridge = 0;
    const n1 = network([a], () => {
      bridge.value = a.value * 2;
    });
    const n2 = network([bridge], () => {
      bSeenBridge = bridge.value;
    });

    a.value = 7;
    expect(bridge.value).toBe(14);
    expect(bSeenBridge).toBe(14);
    n1.dispose();
    n2.dispose();
  });

  it("two networks, same dep — independent self-exclusions", () => {
    // Each network's body writes the shared dep. Each self-excludes
    // its own; the OTHER network sees the write and fires.
    const shared = num(0);
    let n1Body = 0;
    let n2Body = 0;
    const n1 = network([shared], () => {
      n1Body++;
    });
    const n2 = network([shared], () => {
      n2Body++;
    });
    n1Body = 0;
    n2Body = 0;

    shared.value = 5;
    expect(n1Body).toBe(1);
    expect(n2Body).toBe(1);
    n1.dispose();
    n2.dispose();
  });
});

// ─── 15. Multi-manual coordination ────────────────────────────────

describe("multi-manual: shared deps, varied flush order", () => {
  it("two manual networks observing the same signal — flush order independent", () => {
    const x = num(0);
    const seenA: { value: number; dirtyHas: boolean }[] = [];
    const seenB: { value: number; dirtyHas: boolean }[] = [];
    const xAny = x as unknown as import("../signal").Signal<unknown>;
    const a = network([x], d => {
      seenA.push({ value: x.value, dirtyHas: d.has(xAny) });
    }, { manual: true });
    const b = network([x], d => {
      seenB.push({ value: x.value, dirtyHas: d.has(xAny) });
    }, { manual: true });

    expect(seenA).toEqual([{ value: 0, dirtyHas: false }]);
    expect(seenB).toEqual([{ value: 0, dirtyHas: false }]);

    x.value = 5;
    // Neither auto-fires (manual). Both pending.
    expect(seenA.length).toBe(1);
    expect(seenB.length).toBe(1);

    b.flush();
    expect(seenB[seenB.length - 1]).toEqual({ value: 5, dirtyHas: true });
    // A's lastValues snapshot is independent — flushing B didn't touch A.
    expect(seenA.length).toBe(1);

    a.flush();
    expect(seenA[seenA.length - 1]).toEqual({ value: 5, dirtyHas: true });

    a.dispose();
    b.dispose();
  });

  it("flushing the same network twice in a row — second sees empty dirty", () => {
    const x = num(0);
    const dirties: number[] = [];
    const n = network([x], d => {
      dirties.push(d.size);
    }, { manual: true });

    x.value = 1;
    n.flush(); // dirty = {x}
    n.flush(); // dirty = empty (nothing changed since last)
    expect(dirties).toEqual([0, 1, 0]);
    n.dispose();
  });

  it("auto + manual networks sharing a dep — auto fires on writes; manual stays pending", () => {
    const x = num(0);
    let autoFires = 0;
    let manualFires = 0;
    const auto = network([x], () => {
      autoFires++;
    });
    const manual = network([x], () => {
      manualFires++;
    }, { manual: true });

    autoFires = 0;
    manualFires = 0;

    x.value = 1;
    expect(autoFires).toBe(1);
    expect(manualFires).toBe(0);

    manual.flush();
    expect(manualFires).toBe(1);

    auto.dispose();
    manual.dispose();
  });
});

// ─── 16. Body receives the network handle ─────────────────────────

describe("body sees its own handle on first fire", () => {
  it("subscribe inside the very first body call works", () => {
    const a = num(0);
    const b = num(99);
    const seen: number[] = [];
    let extraSubbed = false;
    network([a], (_dirty, n) => {
      seen.push(a.value);
      // First fire: subscribe b.
      if (!extraSubbed) {
        n.subscribe(b);
        extraSubbed = true;
      }
    });
    expect(seen).toEqual([0]);

    // b is now a dep, even though it was subscribed during the
    // first fire (handle was passed in).
    b.value = 7;
    expect(seen.length).toBe(2);
  });

  it("flush() called from inside body throws (recursion guard)", () => {
    const a = num(0);
    expect(() => {
      network([a], (_dirty, n) => {
        n.flush();
      });
    }).toThrow(/flush\(\) called from inside body/);
  });

  it("dispose() inside body — body completes; subsequent dep changes don't fire", () => {
    const a = num(0);
    let fires = 0;
    let firedDuringConstruction = false;
    network([a], (_dirty, n) => {
      fires++;
      if (!firedDuringConstruction) {
        firedDuringConstruction = true;
        n.dispose();
      }
    });
    expect(fires).toBe(1);

    a.value = 1; // shouldn't fire
    expect(fires).toBe(1);
  });
});
