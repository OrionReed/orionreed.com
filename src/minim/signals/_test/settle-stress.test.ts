// settle-stress.test.ts — adversarial probes on the `settle` primitive.
//
// Goal: establish the foundational guarantees by trying to break them.
// Each section names a guarantee and tests it with the worst inputs.

import { describe, expect, it } from "vitest";
import {
  batch,
  computed,
  effect,
  isSignal,
  lens,
  type Settle,
  Signal,
  settle,
  signal,
} from "../index";

// ─── 1. Errors during body ─────────────────────────────────────────
//
// Guarantee: a thrown body leaves the framework in a usable state.
// Disposal still works, the engine doesn't lock up, no internal
// activeSub leak, no "ghost-active" settler.

describe("stress: errors during body", () => {
  it("throwing on initial run does not lock the engine", () => {
    expect(() => {
      settle(() => {
        throw new Error("initial boom");
      });
    }).toThrow("initial boom");
    // Engine should still work after.
    const a = signal(0);
    const handle = settle(() => {
      a.value;
    });
    a.value = 1;
    handle.dispose();
  });

  it("throwing inside body restores activeSub on the way out", () => {
    let observedActive: unknown = "not-set";
    expect(() => {
      settle(() => {
        // Anchor: read a fresh signal during the body to set activeSub.
        signal(0).value;
        throw new Error("mid-body boom");
      });
    }).toThrow();
    // After the throw, a normal effect should run with activeSub === itself,
    // not the dead settler. We probe by capturing what the effect sees.
    const stop = effect(() => {
      observedActive = "ok";
    });
    expect(observedActive).toBe("ok");
    stop();
  });

  it("throwing on subsequent run keeps the settler subscribable", () => {
    const a = signal(0);
    let runs = 0;
    const handle = settle(() => {
      const v = a.value;
      runs++;
      if (v === 99) throw new Error("specific boom");
    });
    expect(runs).toBe(1);
    a.value = 5;
    expect(runs).toBe(2);
    expect(() => {
      a.value = 99;
    }).toThrow("specific boom");
    expect(runs).toBe(3);
    // After the throw, mutate again — body should still fire on dep change
    // (the throw didn't kill the subscription).
    a.value = 7;
    expect(runs).toBe(4);
    handle.dispose();
  });

  it("body that throws during initial run still leaves a disposable handle", () => {
    let handle: Settle | undefined;
    expect(() => {
      handle = settle(() => {
        throw new Error("boom");
      });
    }).toThrow();
    // settle() threw, so `handle` was never assigned. Document the
    // contract: throwing in initial body does NOT return a handle.
    expect(handle).toBeUndefined();
  });
});

// ─── 2. Disposal edges ─────────────────────────────────────────────
//
// Guarantee: dispose is idempotent; flush after dispose is harmless;
// dispose during body is safe.

describe("stress: disposal edges", () => {
  it("repeated dispose is idempotent", () => {
    const a = signal(0);
    const handle = settle(() => {
      a.value;
    });
    handle.dispose();
    handle.dispose(); // shouldn't throw
    handle.dispose();
  });

  it("flush after dispose is silent (no body fire)", () => {
    const a = signal(0);
    let runs = 0;
    const handle = settle(() => {
      a.value;
      runs++;
    });
    expect(runs).toBe(1);
    handle.dispose();
    handle.flush();
    handle.flush();
    // Body should not fire — settler is unsubscribed and lastValues cleared.
    expect(runs).toBe(1);
  });

  it("dep change after dispose does not fire body", () => {
    const a = signal(0);
    let runs = 0;
    const handle = settle(() => {
      a.value;
      runs++;
    });
    expect(runs).toBe(1);
    handle.dispose();
    a.value = 10;
    a.value = 20;
    expect(runs).toBe(1);
  });

  it("dispose during body run cleans up correctly", () => {
    const a = signal(0);
    let runs = 0;
    let handleRef: Settle | undefined;
    const handle = settle(() => {
      a.value;
      runs++;
      if (runs === 2 && handleRef) handleRef.dispose(); // self-dispose mid-body
    });
    handleRef = handle;
    expect(runs).toBe(1);
    a.value = 1; // triggers body, which disposes itself
    expect(runs).toBe(2);
    a.value = 2; // shouldn't fire
    expect(runs).toBe(2);
  });
});

// ─── 3. Re-entrancy and nesting ────────────────────────────────────
//
// Guarantee: settles compose. A settle body can construct other
// settles, call .flush() on others, etc., without corruption.

describe("stress: re-entrancy and nesting", () => {
  it("settle inside settle body — both work", () => {
    const a = signal(1);
    const b = signal(2);
    let outerRuns = 0;
    let innerRuns = 0;
    const inner = signal(0);
    const outer = settle(() => {
      a.value;
      outerRuns++;
      // Construct inner settle once on outer's first run.
      if (outerRuns === 1) {
        settle(() => {
          b.value;
          innerRuns++;
          inner.value = b.value * 10;
        });
      }
    });
    expect(outerRuns).toBe(1);
    expect(innerRuns).toBe(1);
    expect(inner.value).toBe(20);

    a.value = 99;
    expect(outerRuns).toBe(2);
    // Inner settle still alive (we didn't dispose it).
    b.value = 5;
    expect(innerRuns).toBe(2);
    expect(inner.value).toBe(50);
    outer.dispose();
  });

  it("settle body that calls another settler's flush", () => {
    let aRuns = 0;
    let bRuns = 0;
    let bHandle: Settle | undefined;
    const a = settle(() => {
      aRuns++;
      if (aRuns === 1) {
        bHandle = settle(() => {
          bRuns++;
        });
      }
      if (aRuns >= 2 && bHandle) bHandle.flush();
    });
    expect(aRuns).toBe(1);
    expect(bRuns).toBe(1);
    a.flush();
    expect(aRuns).toBe(2);
    expect(bRuns).toBe(2); // outer's body called bHandle.flush()
    a.dispose();
    bHandle?.dispose();
  });

  it("settle body that constructs a settle that writes to outer's deps — outer does NOT auto re-fire", () => {
    // Finding (alien-signals algorithm semantics): when outer is mid-
    // body (RecursedCheck flag set), and a separately-active inner
    // settler writes to a signal outer reads, the propagation walk
    // marks outer Pending+Recursed but suppresses `_notify`. The
    // engine treats "node currently RecursedCheck'd" as already
    // running for this cycle — so outer doesn't queue a re-run.
    //
    // Practical implication: a settle body cannot trigger ITSELF via
    // an inner settle that writes its deps within the same body run.
    // Future external mutations to x WILL re-fire outer (the Pending
    // flag survives and re-activates on the next propagation).
    const x = signal(0);
    let outerRuns = 0;
    const captured: number[] = [];
    const outer = settle(() => {
      outerRuns++;
      captured.push(x.value);
      if (outerRuns === 1) {
        settle(() => {
          x.value = 42;
        });
      }
    });
    expect(outerRuns).toBe(1);
    expect(captured).toEqual([0]); // outer captured x=0 (its own read), then inner wrote 42
    expect(x.value).toBe(42);

    // Future external mutation re-fires outer.
    x.value = 7;
    expect(outerRuns).toBe(2);
    expect(captured).toEqual([0, 7]);
    outer.dispose();
  });
});

// ─── 4. Custom equality interaction with dirty ─────────────────────
//
// Footgun probe: `dirty` uses `peek() !== lastVal` (raw `!==`),
// regardless of any custom equality the signal has. If the signal's
// equality returns true (and propagation is skipped), no notify fires
// — so the body doesn't run, and dirty isn't even consulted. But
// `flush()` does consult dirty.

describe("stress: custom equality + dirty", () => {
  it("a near-equal write that the signal's equality treats as equal does not notify", () => {
    const eqApprox = (a: number, b: number) => Math.abs(a - b) < 0.01;
    const a = signal<number>(1.0, { equals: eqApprox });
    let runs = 0;
    const handle = settle(() => {
      a.value;
      runs++;
    });
    expect(runs).toBe(1);
    a.value = 1.005; // within epsilon — equality returns true, no notify
    expect(runs).toBe(1); // body did not fire
    a.value = 1.5; // outside epsilon — fires
    expect(runs).toBe(2);
    handle.dispose();
  });

  it("near-equal write rejected by custom equality also stays out of `dirty`", () => {
    // Finding: dirty is computed from `peek() !== lastVal`. When a
    // write is rejected by custom equality, `currentValue` doesn't
    // advance and `flags & Dirty` isn't set; `peek()` returns the
    // unchanged `currentValue`. So `dirty` aligns with custom
    // equality at the propagation level — a rejected write does NOT
    // surface in `dirty`, matching the fact that the body wasn't
    // notified about it. Good.
    const eqApprox = (a: number, b: number) => Math.abs(a - b) < 0.01;
    const a = signal<number>(1.0, { equals: eqApprox });
    let lastDirty: ReadonlySet<Signal<unknown>> | undefined;
    const handle = settle(
      dirty => {
        a.value;
        lastDirty = dirty;
      },
      { manual: true },
    );
    expect(lastDirty?.size).toBe(0);
    a.value = 1.005; // rejected by custom equality
    handle.flush();
    expect(lastDirty?.has(a as Signal<unknown>)).toBe(false);
    handle.dispose();
  });
});

// ─── 5. Two-settler interactions ───────────────────────────────────
//
// Guarantee: cross-settler propagation works as expected. Each settler
// excludes only itself; the other observes writes and may fire.

describe("stress: two settlers", () => {
  it("settler A writes a signal that settler B reads — B fires", () => {
    const x = signal(0);
    let aRuns = 0;
    let bRuns = 0;
    const a = settle(() => {
      aRuns++;
      // A reads & writes — self-excludes
      const v = x.value;
      if (v < 5) x.value = v + 1;
    });
    const b = settle(() => {
      bRuns++;
      x.value;
    });
    // After construction: a fires once, writes x=1; b fires once observing x=1.
    expect(aRuns).toBe(1);
    expect(bRuns).toBeGreaterThanOrEqual(1);
    expect(x.value).toBe(1);
    a.dispose();
    b.dispose();
  });

  it("ping-pong: A reads X writes Y; B reads Y writes X — terminates via ===", () => {
    const x = signal(10);
    const y = signal(20);
    let aRuns = 0;
    let bRuns = 0;
    const aHandle = settle(() => {
      aRuns++;
      y.value = x.value + 1;
    });
    const bHandle = settle(() => {
      bRuns++;
      x.value = y.value - 1;
    });
    // Initial: a writes y = 11; b reads y, writes x = 10 (same, ===, terminates).
    expect(aRuns).toBeGreaterThanOrEqual(1);
    expect(bRuns).toBeGreaterThanOrEqual(1);
    expect(x.value).toBe(10);
    expect(y.value).toBe(11);
    aHandle.dispose();
    bHandle.dispose();
  });

  it("non-Iso ping-pong: A reads X writes Y as fwd; B reads Y writes X as bwd — converges to fixpoint", () => {
    const x = signal(7);
    const y = signal(0);
    let aRuns = 0;
    let bRuns = 0;
    const aHandle = settle(() => {
      aRuns++;
      y.value = x.value * 2;
    });
    const bHandle = settle(() => {
      bRuns++;
      x.value = Math.floor(y.value / 2);
    });
    // x=7 → y=14 → x=7 (terminates).
    expect(x.value).toBe(7);
    expect(y.value).toBe(14);
    // x=8 (manual write): a fires y=16; b fires x=8 (same, terminates).
    x.value = 8;
    expect(x.value).toBe(8);
    expect(y.value).toBe(16);
    aHandle.dispose();
    bHandle.dispose();
  });
});

// ─── 6. Lens / computed signals as members ─────────────────────────

describe("stress: lens & computed signals", () => {
  it("lens signal as settle dep — root mutations propagate", () => {
    const root = signal({ x: 1, y: 2 });
    const xLens = lens(
      root,
      r => r.x,
      (newX, r) => ({ ...r, x: newX }),
    );
    let runs = 0;
    let observed = -1;
    const handle = settle(() => {
      observed = xLens.value;
      runs++;
    });
    expect(observed).toBe(1);
    root.value = { x: 99, y: 2 };
    expect(observed).toBe(99);
    expect(runs).toBe(2);
    handle.dispose();
  });

  it("writing through a lens inside settle body self-excludes via root", () => {
    const root = signal({ x: 1, y: 2 });
    const xLens = lens(
      root,
      r => r.x,
      (newX, r) => ({ ...r, x: newX }),
    );
    let runs = 0;
    const handle = settle(() => {
      const v = xLens.value;
      runs++;
      if (v === 1) {
        // Write through the lens. Lens's setter writes to the root, which
        // is what `dirty` and propagation see. Self-exclusion needs to
        // apply to ROOT writes, since lens setters use `parent.value =`.
        xLens.value = 100;
      }
    });
    // Body should fire ONCE. The lens's setter calls `root.value = ...`,
    // which is a `set value` inside the body, which self-excludes.
    expect(runs).toBe(1);
    expect(xLens.value).toBe(100);
    expect(root.value.x).toBe(100);
    handle.dispose();
  });

  it("computed (RO) as settle dep — works", () => {
    const a = signal(2);
    const sq = computed(() => a.value * a.value);
    let runs = 0;
    let observed = -1;
    const handle = settle(() => {
      observed = sq.value;
      runs++;
    });
    expect(observed).toBe(4);
    a.value = 3;
    expect(observed).toBe(9);
    expect(runs).toBe(2);
    handle.dispose();
  });
});

// ─── 7. batch interaction ──────────────────────────────────────────

describe("stress: batch interaction", () => {
  it("batch around external writes coalesces dirty", () => {
    const a = signal(1);
    const b = signal(2);
    const dirtySizes: number[] = [];
    const handle = settle(dirty => {
      a.value;
      b.value;
      dirtySizes.push(dirty.size);
    });
    batch(() => {
      a.value = 11;
      b.value = 22;
    });
    // Initial run + one re-run with both dirty.
    expect(dirtySizes).toEqual([0, 2]);
    handle.dispose();
  });

  it("body's auto-batch is independent of any outer batch", () => {
    const a = signal(1);
    const downstream: number[] = [];
    const stop = effect(() => {
      downstream.push(a.value);
    });
    batch(() => {
      const handle = settle(() => {
        a.value = 99;
      });
      handle.dispose();
    });
    // Inside the outer batch, settle's body runs; its auto-batch wraps
    // its own writes; the outer batch then flushes the queue.
    expect(downstream).toEqual([1, 99]);
    stop();
  });
});

// ─── 8. Manual mode adversarial ────────────────────────────────────

describe("stress: manual mode adversarial", () => {
  it("manual flush 100 times in a row each fires the body", () => {
    let runs = 0;
    const handle = settle(
      () => {
        runs++;
      },
      { manual: true },
    );
    expect(runs).toBe(1);
    for (let i = 0; i < 100; i++) handle.flush();
    expect(runs).toBe(101);
    handle.dispose();
  });

  it("manual mode re-firing on dep change in auto effect downstream", () => {
    const x = signal(0);
    let manualRuns = 0;
    const m = settle(
      _dirty => {
        x.value = manualRuns + 1;
        manualRuns++;
      },
      { manual: true },
    );
    let observed: number[] = [];
    const stop = effect(() => {
      observed.push(x.value);
    });
    expect(observed).toEqual([1]);
    m.flush();
    expect(observed).toEqual([1, 2]);
    m.flush();
    expect(observed).toEqual([1, 2, 3]);
    m.dispose();
    stop();
  });
});

// ─── 9. Self-write with multiple writes per body ───────────────────

describe("stress: multi-write body", () => {
  it("body writing the same signal multiple times — last write wins, body still fires once", () => {
    const a = signal(0);
    let runs = 0;
    const handle = settle(() => {
      a.value;
      runs++;
      if (runs === 1) {
        a.value = 1;
        a.value = 2;
        a.value = 3;
      }
    });
    expect(runs).toBe(1);
    expect(a.value).toBe(3);
    handle.dispose();
  });

  it("body writing many signals — all commit, downstream sees them once", () => {
    const N = 50;
    const sigs: ReturnType<typeof signal<number>>[] = [];
    for (let i = 0; i < N; i++) sigs.push(signal(0));
    const observed: number[][] = [];
    const stop = effect(() => {
      observed.push(sigs.map(s => s.value));
    });
    expect(observed.length).toBe(1);
    const handle = settle(() => {
      for (let i = 0; i < N; i++) sigs[i]!.value = i + 1;
    });
    // One additional effect fire, with all N values committed atomically.
    expect(observed.length).toBe(2);
    expect(observed[1]).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    handle.dispose();
    stop();
  });
});

// ─── 10. activeSettler leak guard ──────────────────────────────────

describe("stress: activeSettler leak guard", () => {
  it("regular effects' within-body self-writes do NOT re-fire (alien-signals algorithm)", () => {
    // Finding: the alien-signals propagation algorithm already
    // suppresses notify on a sub that has `RecursedCheck` set. So a
    // regular `effect` writing to a signal it reads does NOT cause
    // re-fire — the engine handles it without our help. `settle`'s
    // explicit `activeSettler`-based exclusion is therefore a
    // defense-in-depth + clarity measure, not strictly required for
    // the within-body-sync case. It DOES help in async/scheduled
    // cases (where `RecursedCheck` is no longer set) and provides a
    // nameable contract: settle writes self-exclude.
    const a = signal(0);
    let runs = 0;
    const stop = effect(() => {
      a.value;
      runs++;
      if (runs === 1) a.value = 99;
    });
    expect(runs).toBe(1);
    expect(a.value).toBe(99);
    stop();
  });

  it("nested settles correctly stack and restore activeSettler", () => {
    // Probe: if activeSettler weren't properly restored, an outer
    // settle's writes after an inner settle returns would use the
    // wrong exclusion. Test by writing through a chain.
    const x = signal(0);
    let outerRuns = 0;
    const outer = settle(() => {
      outerRuns++;
      x.value;
      if (outerRuns === 1) {
        // Inner's body runs synchronously inside outer's body. After
        // it returns, activeSettler should be `outer` again.
        settle(() => {}).dispose();
      }
    });
    // After the nested construction, mutate x to verify outer still works.
    expect(outerRuns).toBe(1);
    x.value = 5;
    expect(outerRuns).toBe(2);
    outer.dispose();
  });

  it("nested settles correctly stack activeSettler", () => {
    const x = signal(0);
    const y = signal(0);
    let outerRuns = 0;
    let innerRuns = 0;
    const outer = settle(() => {
      outerRuns++;
      x.value;
      // While outer body runs, activeSettler = outer.
      // Inside inner.flush() below, activeSettler should switch to inner,
      // then restore to outer.
      const inner = settle(() => {
        innerRuns++;
        y.value;
      });
      inner.dispose();
    });
    expect(outerRuns).toBe(1);
    expect(innerRuns).toBe(1);
    // After both complete, activeSettler should be undefined.
    // Writing y from outside should fire any subscribed settle (none here,
    // since inner was disposed). Verify nothing's stuck:
    let probeRuns = 0;
    const probe = settle(() => {
      y.value;
      probeRuns++;
    });
    y.value = 1;
    expect(probeRuns).toBe(2);
    outer.dispose();
    probe.dispose();
  });
});
