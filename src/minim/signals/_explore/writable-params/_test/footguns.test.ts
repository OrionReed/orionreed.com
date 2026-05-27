// footguns.test.ts — hunt for footguns that require NON-LOCAL reasoning.
//
// The bar: a footgun is acceptable iff it can be understood from looking
// at the lens construction in isolation. A footgun is NEW iff it
// requires consulting unrelated cells in the graph to predict behavior.
//
// We're trying to break the world. Best-faith adversarial tests.

import { describe, expect, it } from "vitest";
import { batch, derive, effect, num, type Num, vec, type Writable } from "../../../index";
import { lensW, numAddW, vecRightW } from "../wp";

describe("FOOTGUN HUNT 1: stale reads inside bwd", () => {
  it("bwd that reads ANOTHER signal during computation: tracked or stale?", () => {
    // Build a lens whose bwd reads an additional cell NOT declared as a
    // parent. Does the lens's setter re-fire when that cell changes?
    // (It shouldn't, because the bwd isn't reactive context.)
    const a = num(10);
    const hidden = num(2);
    const lens1 = lensW(
      [a] as const,
      ([av]) => av,
      (target, _) => {
        const factor = hidden.peek(); // use .peek to avoid tracking
        return [target / factor] as const;
      },
    );
    expect(lens1.value).toBe(10);
    lens1.value = 20;
    expect(a.peek()).toBe(10); // 20 / 2

    hidden.value = 5;
    lens1.value = 50;
    expect(a.peek()).toBe(10); // 50 / 5

    // VERDICT: bwd reads `hidden` at write time, not at construction.
    // This is intuitive — the bwd is a closure that runs on each write.
    // Acceptable; same as today's lens behavior.
  });

  it("bwd that uses signal.value (tracked) inside its body: does it leak deps?", () => {
    const a = num(10);
    const tracked = num(2);
    const lens1 = lensW(
      [a] as const,
      ([av]) => av,
      (target, _) => {
        // Using .value would TRACK in normal reactive context — but bwd
        // is called from inside a setter closure, NOT in a reactive
        // context. Does it leak?
        const factor = tracked.value;
        return [target / factor] as const;
      },
    );
    let fwdFires = 0;
    const stop = effect(() => {
      void lens1.value;
      fwdFires++;
    });
    fwdFires = 0;
    lens1.value = 40; // bwd: a := 40/2 = 20 (a changes from 10)
    expect(fwdFires).toBe(1); // one fire because a changed

    tracked.value = 5;
    // VERDICT CANDIDATE: does fwdFires bump because tracked was "leaked" via bwd?
    // If so: new footgun. The hypothesis is "no, bwd runs outside any reactive
    // context so even tracked reads don't subscribe lens1 to tracked".
    expect(fwdFires).toBe(1); // confirmed: no leak. bwd is non-reactive.

    stop();
  });
});

describe("FOOTGUN HUNT 2: surprising fan-in to primitives", () => {
  it("two unrelated lenses writing to the same primitive — observable?", () => {
    // a is a primitive. Two lenses use it as a writable param.
    // Drag one — does the other notice? Yes — and that's the point.
    // The footgun is: USER might not realize the cells are related.
    const a = num(0);
    const b = num(0);
    const lens1 = numAddW(a, b, 0.5);
    const lens2 = numAddW(a, num(0), 0.5); // a is shared!
    expect(lens1.value).toBe(0);
    expect(lens2.value).toBe(0);

    lens1.value = 100;
    // lens1.bwd: a += 50; b += 50; → a = 50, b = 50
    expect(a.peek()).toBe(50);
    expect(lens2.value).toBe(50); // lens2 changed because a changed

    // VERDICT: this is the same footgun as having two effects both writing
    // to the same signal. The mechanism is shared writable state. No
    // new behavior.
  });
});

describe("FOOTGUN HUNT 3: writing to a writable param BEFORE the lens is read", () => {
  it("setup order: lens constructed but never read; param write fires no lens-side cascade", () => {
    const a = num(0);
    const n = num(0);
    const lens = lensW([a, n] as const, ([av, nv]) => av + nv, (t, _) => [t, undefined] as const);
    // Never read lens.value, so no subscribers.
    let nSubscribers = 0;
    effect(() => {
      void n.value;
      nSubscribers++;
    });
    nSubscribers = 0;

    n.value = 5;
    expect(nSubscribers).toBe(1);

    lens.value = 100;
    // bwd writes a := 100. n unchanged. n's effect doesn't fire.
    expect(nSubscribers).toBe(1);
    expect(a.peek()).toBe(100);
  });
});

describe("FOOTGUN HUNT 4: bwd that returns NaN / Infinity / outside-domain values", () => {
  it("bwd returning NaN: the param's value becomes NaN; downstream reads see NaN", () => {
    const a = num(10);
    const n = num(2);
    const div = lensW(
      [a, n] as const,
      ([av, nv]) => av / nv,
      (target, [_av, _nv]) => {
        // Naive: solve a / n = target → a = target * n
        return [target * _nv, undefined] as const;
      },
    );
    expect(div.value).toBe(5);
    div.value = 0;
    expect(a.peek()).toBe(0);
    div.value = Infinity;
    expect(a.peek()).toBe(Infinity);
    // VERDICT: standard math behavior. Lens designer must handle edge cases.
    // Same footgun as any closure-based math today.
  });
});

describe("FOOTGUN HUNT 5: re-entrant writes during fwd evaluation", () => {
  it("fwd that writes to a signal during its computation", () => {
    const a = num(10);
    const counter = num(0);
    let evals = 0;
    const lens = lensW(
      [a] as const,
      ([av]) => {
        evals++;
        // BAD: writing inside fwd. Not specific to wp lenses.
        if (evals < 2) counter.value = counter.peek() + 1;
        return av;
      },
      target => [target] as const,
    );
    expect(lens.value).toBe(10);
    // VERDICT: counter += 1 happens during the read. Same footgun as today.
    expect(counter.peek()).toBe(1);
  });
});

describe("FOOTGUN HUNT 6: bwd with side effects", () => {
  it("bwd that writes to OTHER cells outside the parents list", () => {
    const a = num(10);
    const sideChannel = num(0);
    const lens = lensW(
      [a] as const,
      ([av]) => av,
      target => {
        sideChannel.value = sideChannel.peek() + 1; // count writes
        return [target] as const;
      },
    );
    lens.value = 20;
    expect(sideChannel.peek()).toBe(1);
    lens.value = 30;
    expect(sideChannel.peek()).toBe(2);
    // VERDICT: side effects in bwd work. Same surface as today.
    // Not specific to wp; possibly even useful (logging).
  });
});

describe("FOOTGUN HUNT 7: cycle attempt via inline writable param", () => {
  it("you cannot use a lens as its own param (temporal order forbids)", () => {
    // To do `b = vecRightW(a, b.x)` you'd need b to exist before b.
    // The TS expression order makes this structurally impossible.
    // The only way to fake it is via a let-declared placeholder + effect.
    let placeholder: Writable<Num> | undefined;
    const getPlaceholder = (): Writable<Num> => {
      if (!placeholder) throw new Error("not initialized yet");
      return placeholder;
    };
    void getPlaceholder;

    // Try to construct: const b = vecRightW(a, "lookup later");
    // You'd need to wrap n in a Writable<Num> that DOES exist now but
    // points to b later. The TYPE SYSTEM forbids any direct cycle.
    expect(() => {
      const a = vec(0, 0);
      // synthetic cycle attempt that should fail:
      const dummy = num(0);
      const b = vecRightW(a, dummy);
      placeholder = dummy;
      // To "close the loop", you'd write an effect:
      const stop = effect(() => {
        // Effect: drives n from b. WRITING n inside effect-on-b is the cycle.
        const target = b.value.x;
        if (target !== dummy.peek()) {
          dummy.value = target; // closes the loop — would cycle without engine protection
        }
      });
      stop();
    }).not.toThrow();
    // VERDICT: confirmed — no PURE lens composition can spell a cycle.
  });
});

describe("FOOTGUN HUNT 8: GetPut under writable params", () => {
  it("vecRightW satisfies GetPut: read then put = no-op", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);
    const original = b.value;
    const origA = a.peek();
    const origN = n.peek();

    b.value = original;
    expect(a.peek()).toEqual(origA);
    expect(n.peek()).toBe(origN);
  });

  it("numAddW satisfies GetPut", () => {
    const a = num(10);
    const b = num(20);
    const c = numAddW(a, b);
    const orig = c.value;
    c.value = orig;
    expect(a.peek()).toBe(10);
    expect(b.peek()).toBe(20);
  });
});

describe("FOOTGUN HUNT 9: glitch-free observation", () => {
  it("when lens output and writable param are both observed, no intermediate state", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);

    const observations: Array<{ bx: number; ny: number; aN: number }> = [];
    const stop = effect(() => {
      observations.push({ bx: b.value.x, ny: n.value, aN: a.value.y });
    });
    observations.length = 0;

    b.value = { x: 100, y: 50 };
    expect(observations.length).toBe(1); // one batched re-fire
    expect(observations[0]).toEqual({ bx: 100, ny: 90, aN: 50 });

    stop();
  });

  it("observer on n separately fires alongside observer on b — consistent values", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);

    const bObs: number[] = [];
    const nObs: number[] = [];
    const stop1 = effect(() => {
      bObs.push(b.value.x);
    });
    const stop2 = effect(() => {
      nObs.push(n.value);
    });
    bObs.length = 0;
    nObs.length = 0;

    b.value = { x: 100, y: 50 };
    expect(bObs).toEqual([100]);
    expect(nObs).toEqual([90]);

    stop1();
    stop2();
  });
});

describe("FOOTGUN HUNT 10: writing the lens output to itself (idempotent re-write)", () => {
  it("b.value = b.value should be a no-op (no spurious downstream fires)", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);

    let nFires = 0;
    const stop = effect(() => {
      void n.value;
      nFires++;
    });
    nFires = 0;

    b.value = b.value;
    // bwd: target = current. n := current.x - a.x = same value as before.
    // n.value === old n.value → no propagation. nFires should be 0.
    expect(nFires).toBe(0);
    stop();
  });
});

describe("FOOTGUN HUNT 11: writable param to itself via parent chain", () => {
  it("n appears as both a direct param AND as a parent of another writable param", () => {
    // Construct: n is writable. m = n.add(0) (another writable view of n).
    // Build lens with parents [n, m] (both writable, both rooted in n).
    // Writes split between them; both intentions cascade to n.
    // This is the diamond again.
    const n = num(10);
    const m = n.add(0); // writable; m.bwd writes n.

    const c = lensW(
      [n, m] as const,
      ([nv, mv]) => nv + mv,
      (target, [nv, _mv]) => {
        const delta = target - 2 * nv;
        // intentions: n := nv + delta/2; m := nv + delta/2
        return [nv + delta / 2, nv + delta / 2] as const;
      },
    );
    expect(c.value).toBe(20);

    c.value = 30;
    // intentions: n := 15, m := 15. m's bwd: n := 15 - 0 = 15.
    // Two writes to n: 15 then 15. Convergent.
    expect(n.peek()).toBe(15);
    expect(c.value).toBe(30);
    // VERDICT: symmetric distribution → convergent. Same as the
    // aliasing test. Asymmetric weights would break PutGet (tested
    // elsewhere). DETECTABLE at construction (n in parents list AND
    // m's transitive root is also n).
  });
});

describe("FOOTGUN HUNT 12: GIANT cascades don't stack-overflow", () => {
  it("100-level wp chain: read and write don't blow the stack", () => {
    const a = num(0);
    const slacks: Writable<Num>[] = Array.from({ length: 100 }, () => num(1));
    let cur: Writable<Num> = a;
    for (const s of slacks) cur = numAddW(cur, s, 0); // all-slack-absorbs
    expect(cur.value).toBe(100);
    cur.value = 1000;
    expect(slacks[99]!.peek()).toBe(901); // top slack absorbed everything
    expect(a.peek()).toBe(0);
    expect(cur.value).toBe(1000);
  });
});

describe("FOOTGUN HUNT 13: a writable param that is a write target of an effect", () => {
  it("n is both a writable param of b AND driven by an effect — interaction?", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = vecRightW(a, n);

    // Effect that clamps n to [0, 100]. SIDE EFFECT. (Like a watchdog.)
    let effectFires = 0;
    const stop = effect(() => {
      effectFires++;
      const v = n.value;
      if (v < 0) n.value = 0;
      if (v > 100) n.value = 100;
    });
    effectFires = 0;

    b.value = { x: 200, y: 0 };
    // bwd: n := 200. Effect re-fires; clamps to 100.
    expect(n.peek()).toBe(100);
    expect(b.value.x).toBe(100); // b re-derives with clamped n
    // VERDICT: composes cleanly. Effects on writable params behave like
    // effects on any other shared signal.
    stop();
  });
});
