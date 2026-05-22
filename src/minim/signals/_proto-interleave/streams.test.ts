// Tests for stream primitive sketches — exercising what works and
// what doesn't when streams are a distinct primitive vs signal-shaped.

import { describe, expect, it } from "vitest";
import { effect } from "../signal";
import { pushSignal, Stream, stream, trigger } from "./streams";

describe("Stream<T>", () => {
  it("subscribers see every push (no dedup of equal values)", () => {
    const s = stream<number>();
    const seen: number[] = [];
    s.subscribe(v => seen.push(v));
    s.push(1);
    s.push(1); // duplicate — stream emits anyway
    s.push(2);
    expect(seen).toEqual([1, 1, 2]);
  });

  it("late subscriber sees nothing (no replay)", () => {
    const s = stream<number>();
    s.push(1);
    s.push(2);
    const seen: number[] = [];
    s.subscribe(v => seen.push(v));
    expect(seen).toEqual([]);
    s.push(3);
    expect(seen).toEqual([3]);
  });

  it("map/filter chain", () => {
    const s = stream<number>();
    const evens = s.filter(n => n % 2 === 0).map(n => n * 10);
    const seen: number[] = [];
    evens.subscribe(v => seen.push(v));
    [1, 2, 3, 4, 5].forEach(n => s.push(n));
    expect(seen).toEqual([20, 40]);
  });

  it("scan folds the stream into a signal", () => {
    const clicks = stream<void>();
    const count = clicks.scan(0, acc => acc + 1);
    expect(count.peek()).toBe(0);

    let observed = -1;
    effect(() => {
      observed = count.value;
    });
    clicks.push();
    clicks.push();
    clicks.push();
    expect(count.peek()).toBe(3);
    expect(observed).toBe(3);
  });

  it("latest exposes a signal of the most-recent emission", () => {
    const s = stream<string>();
    const latest = s.latest("none");
    s.push("a");
    expect(latest.peek()).toBe("a");
    s.push("b");
    expect(latest.peek()).toBe("b");
  });

  it("close unsubscribes everyone", () => {
    const s = stream<number>();
    const seen: number[] = [];
    s.subscribe(v => seen.push(v));
    s.push(1);
    s.close();
    s.push(2); // no-op
    expect(seen).toEqual([1]);
  });
});

describe("pushSignal (variant 2)", () => {
  it("acts as a stream-via-signal — every push fires effects", () => {
    const { push, signal } = pushSignal<number>();
    const seen: number[] = [];
    effect(() => {
      const v = signal.value;
      if (v) seen.push(v.value);
    });
    push(1);
    push(1); // duplicate value, but fresh wrapper → effect re-fires
    push(2);
    expect(seen).toEqual([1, 1, 2]);
  });
});

describe("Trigger (variant 3)", () => {
  it("counts emissions; subscribers re-fire each count change", () => {
    const t = trigger();
    let n = 0;
    t.on(() => {
      n++;
    });
    t.fire();
    t.fire();
    t.fire();
    expect(n).toBe(3);
    expect(t.count.value).toBe(3);
  });
});

// ── Finding: do we need Stream as its own primitive? ─────────────
//
// pushSignal is a 4-line implementation on top of Signal. It works
// for "subscribers see every emission" but loses .map/.filter
// affordances. Trigger is the same idea for void-valued streams.
//
// Stream<T> as its own class gets you the composition (.map .filter
// .scan) at low cost — but you can build those on top of pushSignal
// too. The honest answer: this is a NAMING question, not a primitive
// one. Signal already gives us push-on-write; the only "novelty" is
// that we'd want write-without-dedup, which is just dropping the
// equality check (and that's already a per-signal option via the
// `equals` field).
//
// So: not a new primitive. A new *idiom* on top of Signal: a "channel"
// signal that has no dedup. Implementable in <10 lines.
