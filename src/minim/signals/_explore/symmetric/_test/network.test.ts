// network.test.ts — reactive sub-DAG with self-excluded writes.

import { describe, expect, it, vi } from "vitest";
import { type Signal, network, signal } from "../index";

describe("network()", () => {
  it("fires on subscribed dep change with the dirty subset", () => {
    const a = signal(1);
    const b = signal(2);
    const seen: Array<readonly string[]> = [];
    const n = network([a, b], (dirty) => {
      seen.push([...dirty].map((s) => (s === a ? "a" : "b")));
    });
    expect(seen).toEqual([[]]); // initial fire, empty dirty
    a.value = 10;
    expect(seen.at(-1)).toEqual(["a"]);
    b.value = 20;
    expect(seen.at(-1)).toEqual(["b"]);
    n.dispose();
  });

  it("self-excludes: a body writing its own dep does not re-fire", () => {
    const a = signal(0);
    const fires = vi.fn();
    // Clamp a to <= 5 from inside the network. Writing `a` here must NOT
    // re-trigger the network (would otherwise loop / double-fire).
    const n = network([a], () => {
      fires();
      if (a.value > 5) a.value = 5;
    });
    expect(fires).toHaveBeenCalledTimes(1);
    a.value = 100;
    // One external change → exactly one more fire; the self-write is excluded.
    expect(fires).toHaveBeenCalledTimes(2);
    expect(a.value).toBe(5);
    n.dispose();
  });

  it("reads inside body do NOT add to topology", () => {
    const dep = signal(1);
    const untracked = signal(100);
    const fires = vi.fn();
    const n = network([dep], () => {
      fires();
      void untracked.value; // read but not subscribed
    });
    expect(fires).toHaveBeenCalledTimes(1);
    untracked.value = 200; // must NOT fire the network
    expect(fires).toHaveBeenCalledTimes(1);
    dep.value = 2;
    expect(fires).toHaveBeenCalledTimes(2);
    n.dispose();
  });

  it("subscribe / unsubscribe grow and shrink topology", () => {
    const a = signal(1);
    const b = signal(2);
    const fires = vi.fn();
    const n = network([a], () => {
      fires();
    });
    expect(fires).toHaveBeenCalledTimes(1);
    b.value = 3; // not subscribed yet
    expect(fires).toHaveBeenCalledTimes(1);

    n.subscribe(b);
    b.value = 4; // now subscribed
    expect(fires).toHaveBeenCalledTimes(2);

    n.unsubscribe(a);
    a.value = 9; // no longer subscribed
    expect(fires).toHaveBeenCalledTimes(2);
    n.dispose();
  });

  it("manual mode only advances on flush()", () => {
    const a = signal(1);
    const fires = vi.fn();
    const n = network(
      [a],
      () => {
        fires();
      },
      { manual: true },
    );
    expect(fires).toHaveBeenCalledTimes(1); // initial
    a.value = 2;
    expect(fires).toHaveBeenCalledTimes(1); // deferred
    n.flush();
    expect(fires).toHaveBeenCalledTimes(2);
    n.dispose();
  });

  it("dispose stops all further firing", () => {
    const a = signal(1);
    const fires = vi.fn();
    const n = network([a], () => {
      fires();
    });
    n.dispose();
    a.value = 5;
    expect(fires).toHaveBeenCalledTimes(1); // only the initial fire
  });

  it("two-way constraint: C = A + B kept consistent without looping", () => {
    // Classic constraint: keep sum = a + b. Writing `sum` splits the
    // delta; writing a/b recomputes sum. Self-exclusion prevents cycles.
    const a = signal(2);
    const b = signal(3);
    const sum = signal(5);
    const fires = vi.fn();
    const n = network([a, b, sum], (dirty) => {
      fires();
      if (dirty.has(sum as Signal<unknown>)) {
        // distribute delta evenly back to a, b
        const delta = sum.value - (a.value + b.value);
        a.value += delta / 2;
        b.value += delta / 2;
      } else {
        sum.value = a.value + b.value;
      }
    });
    a.value = 10;
    expect(sum.value).toBe(13); // 10 + 3
    sum.value = 23; // delta +10 → a,b each +5
    expect(a.value).toBe(15);
    expect(b.value).toBe(8);
    expect(fires.mock.calls.length).toBeLessThan(10); // converges, no runaway
    n.dispose();
  });
});
