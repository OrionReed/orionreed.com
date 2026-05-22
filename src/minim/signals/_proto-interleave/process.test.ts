// Tests for observe() and signalGen() — process state as signals.

import { describe, expect, it } from "vitest";
import type { Animator, Tick } from "../../core";
import { effect } from "../signal";
import { allAlive, anyProducing, observe, signalGen, sleep } from "./process";

const T = (dt: number, elapsed = dt): Tick => ({ dt, elapsed });

describe("observe()", () => {
  it("exposes alive/producing/lastEmit as signals", () => {
    function* gen(): Animator<string> {
      const t = yield;
      void t;
      yield;
      yield;
      return "done";
    }
    const p = observe(gen());

    expect(p.alive.value).toBe(true);
    expect(p.producing.value).toBe(false);
    expect(p.lastEmit.value).toBeUndefined();

    p.step(T(1 / 60));
    expect(p.alive.value).toBe(true);
    p.step(T(1 / 60));
    expect(p.alive.value).toBe(true);
    p.step(T(1 / 60));
    expect(p.alive.value).toBe(true);
    const aliveBefore = p.alive.value;
    void aliveBefore;
    p.step(T(1 / 60));
    expect(p.alive.value).toBe(false);
    expect(p.lastEmit.value).toBe("done");
  });

  it("composes with effects — react to a process ending", () => {
    function* gen(): Animator<void> {
      yield;
      yield;
      yield;
    }
    const p = observe(gen());

    const log: string[] = [];
    effect(() => {
      log.push(p.alive.value ? "running" : "ended");
    });
    expect(log).toEqual(["running"]);
    for (let i = 0; i < 5; i++) p.step(T(1 / 60));
    expect(log).toEqual(["running", "ended"]);
  });

  it("allAlive / anyProducing — compose process signals", () => {
    function* a(): Animator<void> {
      yield;
      yield;
    }
    function* b(): Animator<void> {
      yield;
      yield;
      yield;
      yield;
    }
    const pa = observe(a());
    const pb = observe(b());

    expect(allAlive([pa, pb]).value).toBe(true);
    pa.step(T(1 / 60));
    pa.step(T(1 / 60));
    pa.step(T(1 / 60));
    expect(pa.alive.value).toBe(false);
    expect(allAlive([pa, pb]).value).toBe(false);

    pb.step(T(1 / 60));
    pb.step(T(1 / 60));
    pb.step(T(1 / 60));
    pb.step(T(1 / 60));
    pb.step(T(1 / 60));
    expect(pb.alive.value).toBe(false);

    expect(anyProducing([pa, pb]).value).toBe(false);
  });
});

describe("signalGen()", () => {
  it("a generator IS a signal — yields become value changes", () => {
    const blink = signalGen(function* () {
      while (true) {
        yield true as boolean;
        yield sleep(0.5);
        yield false as boolean;
        yield sleep(0.5);
      }
    }, false);

    const observed: boolean[] = [];
    effect(() => {
      observed.push(blink.signal.value);
    });
    expect(observed).toEqual([false]);

    blink.step(T(0.01));
    expect(blink.signal.peek()).toBe(true);

    blink.step(T(0.4));
    expect(blink.signal.peek()).toBe(true);
    blink.step(T(0.2));
    expect(blink.signal.peek()).toBe(false);

    expect(observed).toContain(true);
    expect(observed).toContain(false);
  });

  it("terminates cleanly when gen returns; numeric T values don't collide with sleep", () => {
    const counter = signalGen<number>(function* () {
      for (let i = 1; i <= 3; i++) {
        yield i; // emit number (not sleep)
        yield sleep(0.1);
      }
    }, 0);

    expect(counter.signal.peek()).toBe(0);

    counter.step(T(0.01));
    expect(counter.signal.peek()).toBe(1);

    counter.step(T(0.2));
    expect(counter.signal.peek()).toBe(2);
    counter.step(T(0.2));
    expect(counter.signal.peek()).toBe(3);
    expect(counter.step(T(0.2))).toBe(false);
  });

  it("composes — derived signals see the evolving value", () => {
    const beat = signalGen<number>(function* () {
      let i = 0;
      while (true) {
        yield ++i;
        yield sleep(0.1);
      }
    }, 0);

    const log: number[] = [];
    effect(() => {
      log.push(beat.signal.value);
    });

    beat.step(T(0.01)); // emits 1
    beat.step(T(0.15)); // emits 2
    beat.step(T(0.15)); // emits 3
    expect(log).toEqual([0, 1, 2, 3]);
  });
});
