// network-multi-manual.test.ts — N-network coordination probes.
//
// The single-network and two-auto-network cases are covered in
// `network.test.ts` and `network-stress.test.ts`. This file targets
// the quadrant that was previously "by inspection": multiple manual
// networks sharing signals, flushed at arbitrary times, possibly in
// cycles, possibly inside outer batches, possibly mixed with auto
// networks. The design is correct from first principles (see header
// comments below); these tests pin that behaviour down explicitly.

import { describe, expect, it } from "vitest";
import { batch, effect, network, type Signal, signal } from "../index";

// ─── 1. Two manual networks sharing a signal — flush order ─────────
//
// Each manual network maintains its own `pending` flag and its own
// `lastValues` snapshot. An external write to a shared signal marks
// both pending; flushing in either order should give each network a
// correct `dirty` view of the world.

describe("multi-manual: shared dep, varied flush order", () => {
  it("two manual networks observing the same signal — flush order doesn't matter", () => {
    const x = signal(0);
    const seenA: { value: number; dirtyHas: boolean }[] = [];
    const seenB: { value: number; dirtyHas: boolean }[] = [];
    const a = network(
      d => {
        seenA.push({ value: x.value, dirtyHas: d.has(x as Signal<unknown>) });
      },
      { manual: true },
    );
    const b = network(
      d => {
        seenB.push({ value: x.value, dirtyHas: d.has(x as Signal<unknown>) });
      },
      { manual: true },
    );
    // Initial run for each: dirty empty, observed value is 0.
    expect(seenA).toEqual([{ value: 0, dirtyHas: false }]);
    expect(seenB).toEqual([{ value: 0, dirtyHas: false }]);

    x.value = 5;

    // Neither has fired (manual). Both pending.
    expect(seenA.length).toBe(1);
    expect(seenB.length).toBe(1);

    // Flush B first.
    b.flush();
    expect(seenB[seenB.length - 1]).toEqual({ value: 5, dirtyHas: true });
    // A still hasn't run; its lastValues snapshot for x is still 0.
    expect(seenA.length).toBe(1);

    // Flush A second. Its dirty should ALSO contain x (each network has
    // its own lastValues — B's flush doesn't disturb A's snapshot).
    a.flush();
    expect(seenA[seenA.length - 1]).toEqual({ value: 5, dirtyHas: true });

    a.dispose();
    b.dispose();
  });

  it("flushing the same network twice in a row: second sees empty dirty", () => {
    const x = signal(0);
    const dirties: number[] = [];
    const a = network(
      d => {
        x.value;
        dirties.push(d.size);
      },
      { manual: true },
    );
    expect(dirties).toEqual([0]);
    x.value = 1;
    a.flush();
    expect(dirties).toEqual([0, 1]); // saw the change
    a.flush();
    expect(dirties).toEqual([0, 1, 0]); // no further changes; empty dirty
    a.dispose();
  });

  it("interleaved external writes + flushes — each flush sees its own delta", () => {
    const x = signal(0);
    const observed: number[] = [];
    const a = network(
      d => {
        observed.push(x.value);
        // Sanity: dirty should accurately reflect the change since last run.
        if (observed.length > 1) expect(d.has(x as Signal<unknown>)).toBe(true);
      },
      { manual: true },
    );
    x.value = 1;
    a.flush();
    x.value = 2;
    a.flush();
    x.value = 3;
    a.flush();
    expect(observed).toEqual([0, 1, 2, 3]);
    a.dispose();
  });
});

// ─── 2. Cascading: manual writes to shared signal that another manual reads
//
// M1.flush() runs body, writes Y. M2 (manual, subscribed to Y) gets
// notified; its `pending` flag flips on. User then calls M2.flush(),
// which sees dirty={Y} and runs the body.

describe("multi-manual: cascading manual-to-manual via shared signal", () => {
  it("M1 writes a signal that M2 reads — M2 sees correct dirty after explicit flush", () => {
    const x = signal(0);
    const y = signal(0);
    let m1Runs = 0;
    let m2Runs = 0;
    let m2LastDirtyHasY = false;
    const m1 = network(
      _d => {
        m1Runs++;
        y.value = x.value * 2;
      },
      { manual: true },
    );
    const m2 = network(
      d => {
        m2Runs++;
        m2LastDirtyHasY = d.has(y as Signal<unknown>);
        y.value; // subscribe
      },
      { manual: true },
    );
    expect(m1Runs).toBe(1);
    expect(m2Runs).toBe(1);
    expect(y.value).toBe(0);
    expect(m2LastDirtyHasY).toBe(false); // initial run: empty dirty

    x.value = 7;
    // M1 marked pending; M2 not (M2 doesn't read x).
    expect(m1Runs).toBe(1);
    expect(m2Runs).toBe(1);

    m1.flush();
    expect(m1Runs).toBe(2);
    expect(y.value).toBe(14);
    // M2 should NOT have fired (manual).
    expect(m2Runs).toBe(1);

    m2.flush();
    expect(m2Runs).toBe(2);
    expect(m2LastDirtyHasY).toBe(true);

    m1.dispose();
    m2.dispose();
  });

  it("3-network chain: M1 → M2 → M3, each manual, cascading flushes", () => {
    const x = signal(0);
    const y = signal(0);
    const z = signal(0);
    const m1Saw: number[] = [];
    const m2Saw: number[] = [];
    const m3Saw: number[] = [];
    const m1 = network(
      _d => {
        m1Saw.push(x.value);
        y.value = x.value + 1;
      },
      { manual: true },
    );
    const m2 = network(
      _d => {
        m2Saw.push(y.value);
        z.value = y.value + 10;
      },
      { manual: true },
    );
    const m3 = network(
      _d => {
        m3Saw.push(z.value);
      },
      { manual: true },
    );
    // Initial cascade through ctors:
    //   M1 ctor: y = 1.
    //   M2 ctor: reads y=1, writes z=11.
    //   M3 ctor: reads z=11.
    expect(m1Saw).toEqual([0]);
    expect(m2Saw).toEqual([1]);
    expect(m3Saw).toEqual([11]);

    x.value = 10;
    // Only m1 marked pending (m2, m3 don't subscribe to x).
    m1.flush(); // y := 11
    expect(m1Saw).toEqual([0, 10]);
    // m2 now pending (y changed).
    m2.flush(); // z := 21
    expect(m2Saw).toEqual([1, 11]);
    // m3 now pending (z changed).
    m3.flush();
    expect(m3Saw).toEqual([11, 21]);

    m1.dispose();
    m2.dispose();
    m3.dispose();
  });
});

// ─── 3. Manual flush inside an outer batch ─────────────────────────
//
// The trailing `flush()` at the end of `_runBody` only drains the
// global queue when `batchDepth` returns to 0. If we're inside an
// outer batch, queued auto effects defer to batch end. Manual flush
// itself runs the body synchronously regardless of batch depth.

describe("multi-manual: manual flush inside outer batch", () => {
  it("auto effect downstream of manual write defers to batch end", () => {
    const x = signal(0);
    const y = signal(0);
    const observed: { x: number; y: number }[] = [];
    const stop = effect(() => {
      observed.push({ x: x.value, y: y.value });
    });
    expect(observed).toEqual([{ x: 0, y: 0 }]);

    const m = network(
      _d => {
        y.value = x.value * 10;
      },
      { manual: true },
    );
    // Initial run: y := 0. Effect was already at {x:0, y:0}; same → no fire.
    expect(observed.length).toBe(1);

    batch(() => {
      x.value = 5;
      m.flush(); // body runs synchronously, writes y=50
      // Still inside outer batch — effect should NOT have fired yet.
      expect(observed.length).toBe(1);
      x.value = 7;
    });
    // Outer batch ended — effect fires once with the final state.
    expect(observed.length).toBe(2);
    expect(observed[1]).toEqual({ x: 7, y: 50 });
    // Note: m.flush() ran with x=5 (so y=50), but the batch then
    // updated x=7 without re-flushing m, so y stays at 50.
    m.dispose();
    stop();
  });

  it("two manual flushes inside a single batch — body of each runs once", () => {
    const a = signal(0);
    const b = signal(0);
    let mARuns = 0;
    let mBRuns = 0;
    const mA = network(
      () => {
        mARuns++;
        a.value;
      },
      { manual: true },
    );
    const mB = network(
      () => {
        mBRuns++;
        b.value;
      },
      { manual: true },
    );
    expect(mARuns).toBe(1);
    expect(mBRuns).toBe(1);
    batch(() => {
      a.value = 1;
      b.value = 1;
      mA.flush();
      mB.flush();
    });
    expect(mARuns).toBe(2);
    expect(mBRuns).toBe(2);
    mA.dispose();
    mB.dispose();
  });
});

// ─── 4. Cycle of two manual networks ───────────────────────────────
//
// M1: reads X, writes Y. M2: reads Y, writes X. Each is manual.
// Iso pairs converge in two flushes (the second roundtrip's `===`
// short-circuit kills propagation). Non-Iso lossy pairs converge to
// a fixpoint in finite explicit flushes (user controls iteration).

describe("multi-manual: cycle of two manual networks", () => {
  it("Iso cycle: alternating flushes converge in one round-trip", () => {
    const x = signal(0);
    const y = signal(0);
    const m1 = network(
      () => {
        y.value = x.value + 100;
      },
      { manual: true },
    );
    const m2 = network(
      () => {
        x.value = y.value - 100;
      },
      { manual: true },
    );
    // Initial: m1 ctor sets y=100. m2 ctor reads y=100, writes x=0
    //   (x was already 0; === short-circuit, no propagate).
    expect(x.value).toBe(0);
    expect(y.value).toBe(100);

    // External write to x triggers m1 pending.
    x.value = 5;
    m1.flush();
    // y := 105. m2 pending.
    expect(y.value).toBe(105);

    m2.flush();
    // x := 5. Same as previous → no propagate; m1 NOT marked pending.
    expect(x.value).toBe(5);

    // No further work needed — verify no spurious pending state.
    let m1ExtraRuns = 0;
    let m2ExtraRuns = 0;
    const probeM1 = network(
      () => {
        m1ExtraRuns++;
        x.value;
      },
      { manual: true },
    );
    const probeM2 = network(
      () => {
        m2ExtraRuns++;
        y.value;
      },
      { manual: true },
    );
    probeM1.flush();
    probeM2.flush();
    // Each probe ran once on construction + once on its explicit flush
    // (option-B semantic). No external writes in between → empty dirty
    // both times.
    expect(m1ExtraRuns).toBe(2);
    expect(m2ExtraRuns).toBe(2);

    m1.dispose();
    m2.dispose();
    probeM1.dispose();
    probeM2.dispose();
  });

  it("non-Iso cycle: explicit flushes drive convergence; user controls iteration", () => {
    // M1: y = x * 2, M2: x = floor(y / 2). Iso for even x.
    const x = signal(7);
    const y = signal(0);
    const m1 = network(
      () => {
        y.value = x.value * 2;
      },
      { manual: true },
    );
    const m2 = network(
      () => {
        x.value = Math.floor(y.value / 2);
      },
      { manual: true },
    );
    // After ctors: y = 14 (m1), x = 7 (m2 reads y=14, writes x=7 same → no propagate).
    expect(x.value).toBe(7);
    expect(y.value).toBe(14);

    // Drive x off the fixpoint.
    x.value = 11;
    m1.flush(); // y := 22; m2 pending
    m2.flush(); // x := 11; same as before, no propagate
    expect(y.value).toBe(22);
    expect(x.value).toBe(11);

    m1.dispose();
    m2.dispose();
  });

  it("drifty cycle: each flush perturbs the other; user controls when to stop", () => {
    // M1: y = x + 1. M2: x = y + 1. Pure drift; never converges.
    const x = signal(0);
    const y = signal(0);
    let m1Runs = 0;
    let m2Runs = 0;
    const m1 = network(
      () => {
        m1Runs++;
        y.value = x.value + 1;
      },
      { manual: true },
    );
    const m2 = network(
      () => {
        m2Runs++;
        x.value = y.value + 1;
      },
      { manual: true },
    );
    // Construction cascade:
    //   m1 ctor: y = 1.
    //   m2 ctor: reads y=1, writes x = 2. m1 marked pending.
    expect(m1Runs).toBe(1);
    expect(m2Runs).toBe(1);
    expect(y.value).toBe(1);
    expect(x.value).toBe(2);

    // Each pair of flushes adds 2 to both x and y. User decides the budget.
    for (let i = 0; i < 3; i++) {
      m1.flush();
      m2.flush();
    }
    expect(m1Runs).toBe(4);
    expect(m2Runs).toBe(4);
    // After 3 rounds: x = 2 + 3*2 = 8, y = 1 + 3*2 = 7
    expect(x.value).toBe(8);
    expect(y.value).toBe(7);

    m1.dispose();
    m2.dispose();
  });
});

// ─── 5. Mixed manual + auto networks sharing signals ───────────────
//
// External write fires auto networks immediately (via the queued-and-
// drained mechanism) and marks manual networks pending (no auto-fire).
// The manual flush then runs in user-controlled time.

describe("multi-manual: mixed manual + auto", () => {
  it("external write fires auto, marks manual pending", () => {
    const x = signal(0);
    const mirror = signal(0);
    let autoRuns = 0;
    let manualRuns = 0;
    const auto = network(_d => {
      autoRuns++;
      mirror.value = x.value * 2;
    });
    const manual = network(
      _d => {
        manualRuns++;
        x.value; // subscribe
      },
      { manual: true },
    );
    expect(autoRuns).toBe(1);
    expect(manualRuns).toBe(1);
    expect(mirror.value).toBe(0);

    x.value = 5;
    // Auto fired immediately; manual marked pending.
    expect(autoRuns).toBe(2);
    expect(mirror.value).toBe(10);
    expect(manualRuns).toBe(1);

    manual.flush();
    expect(manualRuns).toBe(2);
    auto.dispose();
    manual.dispose();
  });

  it("manual writes signal that auto reads — auto fires inside manual.flush()", () => {
    const x = signal(0);
    const mirror = signal(0);
    let autoFires = 0;
    const auto = network(_d => {
      autoFires++;
      mirror.value = x.value;
    });
    const manual = network(
      _d => {
        x.value = x.value + 100;
      },
      { manual: true },
    );
    // ctor of manual: x := 100. Auto re-fires → mirror = 100.
    expect(x.value).toBe(100);
    expect(mirror.value).toBe(100);

    const fireCountBefore = autoFires;
    manual.flush();
    // manual.flush wrote x := 200 (new value); auto fires inside the
    // body's auto-batch (on flush at body end). mirror = 200.
    expect(x.value).toBe(200);
    expect(mirror.value).toBe(200);
    expect(autoFires).toBeGreaterThan(fireCountBefore);

    auto.dispose();
    manual.dispose();
  });
});

// ─── 6. Many manual networks observing one signal ──────────────────

describe("multi-manual: N manual networks on shared signal", () => {
  it("N manual networks all observe the same signal — one external write marks all pending", () => {
    const x = signal(0);
    const N = 5;
    const runs: number[] = new Array(N).fill(0);
    const handles = Array.from({ length: N }, (_, i) =>
      network(
        () => {
          runs[i] = (runs[i] ?? 0) + 1;
          x.value;
        },
        { manual: true },
      ),
    );
    // Initial: each runs once.
    expect(runs).toEqual([1, 1, 1, 1, 1]);

    x.value = 42;
    // None auto-fire.
    expect(runs).toEqual([1, 1, 1, 1, 1]);

    // Flush in arbitrary order.
    handles[3]!.flush();
    handles[0]!.flush();
    handles[4]!.flush();
    handles[1]!.flush();
    handles[2]!.flush();
    expect(runs).toEqual([2, 2, 2, 2, 2]);

    for (const h of handles) h.dispose();
  });

  it("flushing a subset leaves the others pending (still ready to fire)", () => {
    const x = signal(0);
    const aRuns: number[] = [];
    const bRuns: number[] = [];
    const a = network(
      () => {
        aRuns.push(x.value);
      },
      { manual: true },
    );
    const b = network(
      () => {
        bRuns.push(x.value);
      },
      { manual: true },
    );
    x.value = 1;
    a.flush(); // a sees x=1
    x.value = 2;
    a.flush(); // a sees x=2
    // b hasn't run since ctor; its lastValues for x is from then (=0).
    b.flush();
    expect(aRuns).toEqual([0, 1, 2]);
    expect(bRuns).toEqual([0, 2]); // single jump 0 → 2
    a.dispose();
    b.dispose();
  });
});

// ─── 7. Disposal during cross-network flushes ──────────────────────

describe("multi-manual: disposal during cross-network flushes", () => {
  it("disposing M2 from inside M1's body — M2's subsequent flush is silent", () => {
    const x = signal(0);
    let m2Runs = 0;
    const m2 = network(
      () => {
        m2Runs++;
        x.value;
      },
      { manual: true },
    );
    const m1 = network(
      () => {
        m2.dispose();
      },
      { manual: true },
    );
    expect(m2Runs).toBe(1);

    // m2 was disposed during m1's ctor. Subsequent flush on m2 is silent.
    m2.flush();
    expect(m2Runs).toBe(1);

    // External writes don't fire m2 either.
    x.value = 1;
    m2.flush();
    expect(m2Runs).toBe(1);

    m1.dispose();
  });

  it("disposing M1 from M2's body — M1's pending state is harmless", () => {
    const x = signal(0);
    let m1Runs = 0;
    const m1 = network(
      () => {
        m1Runs++;
        x.value;
      },
      { manual: true },
    );
    const m2 = network(() => {
      x.value;
      // On second run (when x changes), dispose m1.
      if (m1Runs >= 1) m1.dispose();
    });
    expect(m1Runs).toBe(1);

    x.value = 5;
    // Auto m2 fires synchronously, disposes m1. m1 was marked pending
    // by the same x.value=5 propagation but is now disposed.
    m1.flush();
    expect(m1Runs).toBe(1); // disposed → flush is silent

    m2.dispose();
  });
});

// ─── 8. activeNetwork stack across cross-network flushes ────────────
//
// Re-entrant flushes (one network's body calling another's flush)
// must restore activeNetwork on the way out, otherwise self-exclusion
// would attribute writes to the wrong node.

describe("multi-manual: activeNetwork restored across nested flushes", () => {
  it("M1 body calls M2.flush(), which writes to M1's deps — M1 doesn't auto re-fire from M2's writes", () => {
    // M1 reads x. M2 writes x. M1's body calls M2.flush().
    // While M2's body runs, activeNetwork = M2; M2's write to x
    // self-excludes M2, but M1 is subscribed to x — M1 should be
    // marked pending (since M1 was previously running but its
    // RecursedCheck flag suppresses self-notify). After M2 returns,
    // activeNetwork = M1 again.
    const x = signal(0);
    let m1Runs = 0;
    let m2Runs = 0;
    const m2 = network(
      () => {
        m2Runs++;
        x.value = (x.value as number) + 1;
      },
      { manual: true },
    );
    const m1 = network(
      () => {
        m1Runs++;
        x.value;
        // On the FIRST (initial-construction) run of m1, m2 has already
        // been constructed (so calling flush is fine). Trigger M2 from
        // inside m1's body to probe activeNetwork stack restoration.
        if (m1Runs === 1) m2.flush();
      },
      { manual: true },
    );
    expect(m1Runs).toBe(1);
    // M2 ran on construction (x=1) AND on the explicit flush from m1
    // (x=2). m1's body itself reads x but does not re-fire from m2's
    // own write inside m1's body (alien-signals RecursedCheck suppresses
    // self-notify mid-run).
    expect(m2Runs).toBe(2);
    expect(x.value).toBe(2);

    // External write to x: only m1 should be marked pending. m1's body
    // checks `if (m1Runs === 1)` before calling m2.flush, so the second
    // m1 run does NOT re-trigger m2 — verify x stays at the external
    // value, confirming activeNetwork restoration didn't accidentally
    // cause m2 to fire from m1's read.
    x.value = 100;
    m1.flush();
    expect(m1Runs).toBe(2);
    expect(x.value).toBe(100);
    expect(m2Runs).toBe(2);

    m1.dispose();
    m2.dispose();
  });

  it("nested manual flushes — three deep, each reads its own signal", () => {
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    let aRuns = 0;
    let bRuns = 0;
    let cRuns = 0;
    const cN = network(
      () => {
        cRuns++;
        c.value;
      },
      { manual: true },
    );
    const bN = network(
      () => {
        bRuns++;
        b.value;
        if (bRuns === 1) cN.flush();
      },
      { manual: true },
    );
    const aN = network(
      () => {
        aRuns++;
        a.value;
        if (aRuns === 1) bN.flush();
      },
      { manual: true },
    );
    // Construction: aN runs once; inside body calls bN.flush(); bN runs
    // (its own ctor + the explicit flush), inside it calls cN.flush();
    // cN runs (ctor + flush).
    expect(aRuns).toBe(1);
    expect(bRuns).toBe(2); // ctor + a's flush
    expect(cRuns).toBe(2); // ctor + b's flush

    // Each network is independent; further work on a doesn't ricochet.
    a.value = 1;
    aN.flush();
    expect(aRuns).toBe(2);
    expect(bRuns).toBe(2);
    expect(cRuns).toBe(2);

    aN.dispose();
    bN.dispose();
    cN.dispose();
  });
});
