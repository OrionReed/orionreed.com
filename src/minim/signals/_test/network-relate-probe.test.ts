// network-relate-probe.test.ts — lossy-relate counter-example probe.
//
// Question: is the inability of a single-network to handle lossy
// fwd/bwd convergence a counter-example to `network` being the right
// primitive?
//
// Approach: build several variants of "relate"-flavoured kernels
// against `network` and see what semantics each gives. Document where
// `network` falls short, where it's elegant, and where the user's
// design intent (one-shot vs fixpoint) maps onto framework choices.

import { describe, expect, it } from "vitest";
import { network, type Signal, signal, type Writable } from "../index";

interface Handle {
  dispose(): void;
}

// ─── Variant A: single-network, direction selection via dirty ────────
//
// One network subscribes to both. On dep change, picks a side from
// `dirty` and writes the other. Self-excludes — the second roundtrip
// (bwd → fwd → bwd) never happens.
//
// Behavior:
//   - Iso (bwd∘fwd = id): correct in one shot.
//   - Lossy contractive (bwd∘fwd ≠ id, but converges): one shot
//     leaves an inconsistent state that does NOT converge.
//   - Drift-prone: same one-shot, no risk of looping.

function relateSingle<A, B>(
  a: Writable<Signal<A>>,
  b: Writable<Signal<B>>,
  fwd: (a: A) => B,
  bwd: (b: B) => A,
): Handle {
  const aSig = a;
  const bSig = b;
  const handle = network(dirty => {
    const aHot = dirty.has(aSig as Signal<unknown>);
    const bHot = dirty.has(bSig as Signal<unknown>);
    const av = aSig.value;
    const bv = bSig.value;
    if (dirty.size === 0) bSig.value = fwd(av);
    else if (aHot && !bHot) bSig.value = fwd(av);
    else if (bHot && !aHot) aSig.value = bwd(bv);
  });
  return { dispose: handle.dispose };
}

// ─── Variant B: two-network, one per direction ───────────────────────
//
// Mirrors the existing `relate` shape: two networks ping-pong via
// cross-network propagation. Each direction self-excludes; the other
// observes the write. Converges via `===` short-circuit when
// bwd∘fwd reaches a fixpoint.

function relateTwo<A, B>(
  a: Writable<Signal<A>>,
  b: Writable<Signal<B>>,
  fwd: (a: A) => B,
  bwd: (b: B) => A,
): Handle {
  const aSig = a;
  const bSig = b;
  const fwdHandle = network(_d => {
    bSig.value = fwd(aSig.value);
  });
  const bwdHandle = network(_d => {
    aSig.value = bwd(bSig.value);
  });
  return {
    dispose() {
      fwdHandle.dispose();
      bwdHandle.dispose();
    },
  };
}

// ─── Variant C: single-network with internal fuel loop ───────────────
//
// One network, but body iterates internally to a fixpoint or fuel cap.
// Demonstrates that single-network CAN do convergence — kernel just
// needs to loop manually.

function relateLoop<A, B>(
  a: Writable<Signal<A>>,
  b: Writable<Signal<B>>,
  fwd: (a: A) => B,
  bwd: (b: B) => A,
  fuel = 32,
): Handle {
  const aSig = a;
  const bSig = b;
  const handle = network(dirty => {
    let aHot = dirty.has(aSig as Signal<unknown>);
    let bHot = dirty.has(bSig as Signal<unknown>);
    let av = aSig.value;
    let bv = bSig.value;
    if (dirty.size === 0) {
      bSig.value = fwd(av);
      return;
    }
    for (let i = 0; i < fuel; i++) {
      if (aHot && !bHot) {
        const newB = fwd(av);
        if (newB === bv) break;
        bSig.value = newB;
        bv = newB;
        aHot = false;
        bHot = true;
      } else if (bHot && !aHot) {
        const newA = bwd(bv);
        if (newA === av) break;
        aSig.value = newA;
        av = newA;
        aHot = true;
        bHot = false;
      } else break;
    }
  });
  return { dispose: handle.dispose };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("relate probe — Iso pair", () => {
  // bwd ∘ fwd = id. All three variants should produce the same result.
  const fwd = (x: number) => x + 100;
  const bwd = (y: number) => y - 100;

  it("single-network: Iso converges in one shot", () => {
    const a = signal(0);
    const b = signal(0);
    const r = relateSingle(a, b, fwd, bwd);
    expect(b.value).toBe(100);
    a.value = 5;
    expect(b.value).toBe(105);
    b.value = 200;
    expect(a.value).toBe(100);
    r.dispose();
  });

  it("two-network: Iso converges in one shot via ping-pong", () => {
    const a = signal(0);
    const b = signal(0);
    const r = relateTwo(a, b, fwd, bwd);
    expect(b.value).toBe(100);
    a.value = 5;
    expect(b.value).toBe(105);
    b.value = 200;
    expect(a.value).toBe(100);
    r.dispose();
  });

  it("loop-network: Iso converges in one shot", () => {
    const a = signal(0);
    const b = signal(0);
    const r = relateLoop(a, b, fwd, bwd);
    expect(b.value).toBe(100);
    a.value = 5;
    expect(b.value).toBe(105);
    b.value = 200;
    expect(a.value).toBe(100);
    r.dispose();
  });
});

describe("relate probe — lossy contractive pair", () => {
  // fwd(x) = x * 2, bwd(y) = floor(y / 2). Lossy: bwd(fwd(x)) = x for
  // x integer, but fwd(bwd(y)) = floor(y/2) * 2 ≠ y for odd y.
  const fwd = (x: number) => x * 2;
  const bwd = (y: number) => Math.floor(y / 2);

  it("single-network: lossy WRITE-from-b leaves inconsistent state", () => {
    const a = signal(0);
    const b = signal(0);
    const r = relateSingle(a, b, fwd, bwd);
    expect(b.value).toBe(0);
    a.value = 5;
    expect(b.value).toBe(10); // fine — fwd direction
    b.value = 7;
    // Single-network: dirty = {b}, picks bwd, writes a := 3. Self-exc.
    // No second roundtrip — b stays at 7, a at 3. fwd(a) = 6 ≠ 7.
    expect(a.value).toBe(3);
    expect(b.value).toBe(7);
    expect(fwd(a.value)).toBe(6); // INCONSISTENT
    r.dispose();
  });

  it("two-network: lossy converges to a fixpoint via ping-pong", () => {
    const a = signal(0);
    const b = signal(0);
    const r = relateTwo(a, b, fwd, bwd);
    a.value = 5;
    expect(b.value).toBe(10);
    b.value = 7;
    // Two-network: e2 fires for b's write, writes a = bwd(7) = 3.
    // e1 (separate network, not excluded by e2) observes a's write,
    // fires, writes b = fwd(3) = 6. Round-trip: a=3 → b=6 (consistent).
    expect(a.value).toBe(3);
    expect(b.value).toBe(6);
    expect(fwd(a.value)).toBe(b.value); // CONSISTENT
    r.dispose();
  });

  it("loop-network: lossy converges in one body run via internal fuel", () => {
    const a = signal(0);
    const b = signal(0);
    const r = relateLoop(a, b, fwd, bwd);
    a.value = 5;
    expect(b.value).toBe(10);
    b.value = 7;
    expect(a.value).toBe(3);
    expect(b.value).toBe(6);
    expect(fwd(a.value)).toBe(b.value);
    r.dispose();
  });
});

describe("relate probe — drifty (non-converging) pair", () => {
  // fwd(x) = x + 1, bwd(y) = y + 1. Each roundtrip drifts by +2.
  // Pure ping-pong would loop forever.
  const fwd = (x: number) => x + 1;
  const bwd = (y: number) => y + 1;

  it("single-network: drifty write completes without looping (one-shot)", () => {
    const a = signal(0);
    const b = signal(0);
    const r = relateSingle(a, b, fwd, bwd);
    expect(b.value).toBe(1); // initial fwd
    a.value = 10;
    expect(b.value).toBe(11);
    expect(a.value).toBe(10);
    b.value = 100;
    expect(a.value).toBe(101);
    expect(b.value).toBe(100);
    // No drift; one-shot terminates.
    r.dispose();
  });

  it("loop-network: drifty terminates via fuel cap (no === short-circuit)", () => {
    const a = signal(0);
    const b = signal(0);
    const r = relateLoop(a, b, fwd, bwd, 5);
    expect(b.value).toBe(1);
    // Now manually write — loop will iterate up to fuel.
    a.value = 0;
    // After fuel iters: each roundtrip increments. Final state depends
    // on fuel parity. The point: it terminates in bounded time.
    expect(Number.isFinite(a.value)).toBe(true);
    expect(Number.isFinite(b.value)).toBe(true);
    r.dispose();
  });
});

describe("relate probe — chain of three (a ↔ b ↔ c)", () => {
  // Chain: relate(a, b, …) and relate(b, c, …). Mutating a should
  // propagate through both relations to c.
  const inc = (x: number) => x + 1;
  const dec = (y: number) => y - 1;

  it("two-network relate composes: a → b → c", () => {
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    relateTwo(a, b, inc, dec);
    relateTwo(b, c, inc, dec);
    expect(b.value).toBe(1);
    expect(c.value).toBe(2);
    a.value = 10;
    expect(b.value).toBe(11);
    expect(c.value).toBe(12);
    c.value = 50;
    expect(b.value).toBe(49);
    expect(a.value).toBe(48);
    // Disposes happen via test cleanup.
  });

  it("single-network relate composes for Iso pairs", () => {
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    relateSingle(a, b, inc, dec);
    relateSingle(b, c, inc, dec);
    a.value = 10;
    expect(b.value).toBe(11);
    expect(c.value).toBe(12);
    c.value = 50;
    expect(b.value).toBe(49);
    expect(a.value).toBe(48);
  });
});

describe("relate probe — what variant for what use case", () => {
  // This is the take-away test: it documents which kernel choice
  // matches which intent.
  it("constraint-style 'enforce equation always': two-network with === termination", () => {
    // Use case: "x + y = 10". fwd(x) = 10 - x, bwd(y) = 10 - y. Iso.
    // Both writers commit; the solver is symmetric.
    const x = signal(2);
    const y = signal(0);
    relateTwo(
      x,
      y,
      vx => 10 - vx,
      vy => 10 - vy,
    );
    expect(y.value).toBe(8);
    x.value = 3;
    expect(y.value).toBe(7);
    y.value = 4;
    expect(x.value).toBe(6);
  });

  it("UI-style 'reflect and stay there until next write': single-network one-shot", () => {
    // Use case: meters ↔ feet display. User writes one side; the other
    // updates. We DON'T want feedback to round-trip back.
    const m = signal(100);
    const f = signal(0);
    relateSingle(
      m,
      f,
      x => x * 3.281,
      y => y / 3.281,
    );
    expect(f.value).toBe(328.1);
    f.value = 100;
    // One-shot: writes m = bwd(100) ≈ 30.479..., then stops.
    // (vs two-network, which would round-trip back to f = fwd(30.479) ≈ 99.99...)
    expect(Math.abs(m.value - 30.479) < 0.01).toBe(true);
    expect(f.value).toBe(100); // unchanged — one-shot didn't round-trip
  });

  it("solver-style 'iterate to fixpoint': loop-network finds it within fuel", () => {
    // Contractive map: bwd(y) = (y + 5) / 2 has fixpoint at 5.
    // fwd is identity. Inside one network body, loop-network iterates
    // bwd∘fwd until it converges (≈ 5). This is genuinely solver-
    // shaped — fixpoint iteration in a single body run.
    const a = signal(0);
    const b = signal(0);
    relateLoop(
      a,
      b,
      x => x,
      y => (y + 5) / 2,
      64,
    );
    a.value = 7;
    // After the loop: a, b converge to ~5 within 64 iters.
    expect(Math.abs(a.value - 5) < 0.001).toBe(true);
    expect(Math.abs(b.value - 5) < 0.001).toBe(true);
  });
});
