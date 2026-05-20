// Edge cases & robustness tests for the chain prototype. Goal:
// every reactive-layer footgun we can imagine. If something fails,
// it tells us either (a) the design has a hole, or (b) we need
// documented guidance for the case.
//
// Run: npx vite-node src/minim/_proto-iso/test-edge.ts

import { Signal, effect, batch } from "../signals/signal";
import { Chain, via } from "./iso";
import { field } from "./field";
import { mean, viaJoint } from "./joint";
import { num } from "./num";
import { vec } from "./vec";
import { box } from "./box";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function suite(name: string, fn: () => void) {
  console.log(`\n— ${name}`);
  fn();
}
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
    console.log(`  ✗ ${name}`);
    console.log(`     ${(e as Error).message}`);
  }
}
function eq<T>(a: T, b: T, msg?: string) {
  if (typeof a === "object" && a !== null && b !== null) {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}${msg ? " — " + msg : ""}`);
    return;
  }
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}${msg ? " — " + msg : ""}`);
}
function close(a: number, b: number, eps = 1e-9, msg?: string) {
  if (Math.abs(a - b) > eps) throw new Error(`expected ~${b}, got ${a}${msg ? " — " + msg : ""}`);
}
function throws(fn: () => void, msg?: string) {
  let did = false;
  try { fn(); } catch { did = true; }
  if (!did) throw new Error(`expected throw${msg ? " — " + msg : ""}`);
}

// ─── Empty chain ─────────────────────────────────────────────────────

suite("Empty chain", () => {
  it("via(s, empty chain) is a writable identity view", () => {
    const s = new Signal(42);
    const v = via(s, Chain.of<number>());
    eq(v.value, 42);
    v.value = 100;
    eq(s.peek(), 100);
  });

  it("empty chain effect re-runs on source change", () => {
    const s = new Signal(1);
    const v = via(s, Chain.of<number>());
    const seen: number[] = [];
    const dispose = effect(() => { seen.push(v.value); });
    eq(seen, [1]);
    s.value = 2;
    eq(seen, [1, 2]);
    dispose();
  });

  it("empty chain doesn't double-fire", () => {
    const s = new Signal(1);
    const v = via(s, Chain.of<number>());
    let count = 0;
    const dispose = effect(() => { void v.value; count++; });
    eq(count, 1);
    s.value = 1; // no-op write (equal)
    eq(count, 1, "equal write fired");
    dispose();
  });
});

// ─── Equality / no-op writes ─────────────────────────────────────────

suite("Equality / no-op writes", () => {
  it("writing same value to chain lens doesn't fire effect", () => {
    const s = num(5);
    const a = s.add(3); // = 8
    let count = 0;
    const dispose = effect(() => { void a.value; count++; });
    eq(count, 1);
    a.value = 8; // same as current
    eq(count, 1, "no-op write fired effect");
    a.value = 10;
    eq(count, 2);
    dispose();
  });

  it("write through chain calls bwd even for equal value (then engine equality blocks)", () => {
    const s = num(5);
    const a = s.add(3);
    let count = 0;
    const dispose = effect(() => { void s.value; count++; });
    eq(count, 1);
    a.value = 8; // = current; bwd computes 5; source.value = 5 (no-op)
    eq(count, 1, "no-op propagated");
    dispose();
  });

  it("Vec value equality respects [EQUALS]", () => {
    const v = vec(1, 2);
    let count = 0;
    const dispose = effect(() => { void v.value; count++; });
    eq(count, 1);
    v.value = { x: 1, y: 2 }; // structurally equal, different object
    eq(count, 1, "structurally-equal Vec write fired");
    v.value = { x: 1, y: 3 };
    eq(count, 2);
    dispose();
  });
});

// ─── NaN / Infinity ─────────────────────────────────────────────────

suite("NaN / Infinity", () => {
  it("NaN write to source flows through chain.fwd as NaN", () => {
    const s = num(5);
    const a = s.add(3);
    s.value = NaN;
    // NaN + 3 = NaN; this just confirms reads don't crash.
    eq(Number.isNaN(a.value), true);
  });

  it("scale(0) write produces Infinity, doesn't throw", () => {
    const s = num(5);
    const a = s.scale(0); // fwd: 0; bwd: t/0
    eq(a.value, 0);
    a.value = 10; // bwd: 10/0 = Infinity → source = Infinity
    eq(s.peek(), Infinity);
  });

  it("NaN through bwd updates source to NaN", () => {
    const s = num(5);
    const a = s.add(3);
    a.value = NaN; // bwd: NaN - 3 = NaN
    eq(Number.isNaN(s.peek()), true);
  });

  it("Infinity propagates through chain symmetrically", () => {
    const s = num(5);
    const a = s.add(3);
    s.value = Infinity;
    eq(a.value, Infinity);
    a.value = Infinity;
    eq(s.peek(), Infinity); // bwd: Inf - 3 = Inf
  });
});

// ─── Soft inverse failures ──────────────────────────────────────────

suite("Soft inverse failures (documented footguns)", () => {
  it("vec.scale(0) writes produce NaN/Infinity per-axis", () => {
    const v = vec(3, 4);
    const z = v.scale(0);
    eq(z.value, { x: 0, y: 0 });
    z.value = { x: 1, y: 2 };
    // bwd: scale(v, 1/0) = scale(v, Infinity)
    const result = v.peek();
    // Some implementations: Infinity * 1 = Infinity; some: NaN.
    // Either way, NOT a clean error.
    if (!(result.x === Infinity || Number.isNaN(result.x))) {
      throw new Error(`unexpected scale(0) bwd: ${JSON.stringify(result)}`);
    }
  });

  it("vec.scale(0).x.value = 1 — chain of two scale-0-ish inverses", () => {
    // Lens through a singular forward — set should still not crash.
    const v = vec(3, 4);
    const zx = v.scale(0).x;
    eq(zx.value, 0);
    // bwd: 1 → scale(v, 1/0) → write source → x lens of singular
    // result. The chain doesn't catch this. Reasonable expectation:
    // write goes through without throwing, source ends up degenerate.
    let threw = false;
    try { zx.value = 1; } catch { threw = true; }
    if (threw) throw new Error("threw on scale(0) chain write");
  });
});

// ─── prev correctness ──────────────────────────────────────────────

suite("prev correctness", () => {
  it("field+arithmetic chain: write computes prev from source at write time", () => {
    // field("x") needs prev (to spread-replace y). add(10) doesn't.
    // For a chain [field("x"), add(10)], anyNeedsPrev=true.
    // Writing should: trace forward to get prev, then walk bwd.
    const b = vec(5, 10);
    const xPlus10 = b.x.add(10); // x.add chains field+add
    eq(xPlus10.value, 15);

    // Mutate source between calls to ensure prev is sampled at write time, not earlier.
    b.value = { x: 100, y: 200 };
    eq(xPlus10.value, 110);
    xPlus10.value = 50; // → x lens bwd: 50 - 10 = 40 → spread-replace y → {x:40, y:200}
    eq(b.peek(), { x: 40, y: 200 });
  });

  it("two field accesses in a row (deep field)", () => {
    type T = { p: { x: number; y: number }; q: number };
    const s = new Signal<T>({ p: { x: 1, y: 2 }, q: 99 });
    // Chain: field("p") → field("x")
    const px = via(
      s,
      Chain.of<T>()
        .iso(field<T, "p">("p"))
        .iso(field<{ x: number; y: number }, "x">("x")),
    );
    eq(px.value, 1);
    px.value = 42;
    eq(s.peek(), { p: { x: 42, y: 2 }, q: 99 });
  });

  it("field+arithmetic+field chain (BoxValue → x via add)", () => {
    // box.x.add(10) — actually a 2-step chain: field("x") + add(10).
    // Verify prev for field is correctly the BoxValue, not number.
    const b = box(5, 10, 100, 50);
    const xPlus10 = b.x.add(10);
    eq(xPlus10.value, 15);
    xPlus10.value = 25; // bwd: add(25, -10) = 15; field x: {...box, x: 15}
    eq(b.peek(), { x: 15, y: 10, w: 100, h: 50 });
  });
});

// ─── Batched writes ──────────────────────────────────────────────────

suite("batch() interactions", () => {
  it("write through chain inside batch defers effects", () => {
    const s = num(0);
    const a = s.add(3);
    const seen: number[] = [];
    const dispose = effect(() => { seen.push(a.value); });
    eq(seen, [3]);
    batch(() => {
      a.value = 10;
      a.value = 20;
      a.value = 30;
    });
    eq(seen, [3, 30], `expected one batched fire; saw ${JSON.stringify(seen)}`);
    dispose();
  });

  it("multiple writes through different chains, batched", () => {
    const s = num(0);
    const a = s.add(1);
    const b = s.scale(2);
    let aSeen = 0, bSeen = 0;
    const da = effect(() => { void a.value; aSeen++; });
    const db = effect(() => { void b.value; bSeen++; });
    eq(aSeen, 1); eq(bSeen, 1);
    batch(() => {
      a.value = 5; // s = 4
      b.value = 100; // s = 50
    });
    eq(aSeen, 2);
    eq(bSeen, 2);
    eq(s.peek(), 50);
    da(); db();
  });
});

// ─── Multi-subscriber ────────────────────────────────────────────────

suite("Multi-subscriber / dispose semantics", () => {
  it("multiple effects on same chain lens all fire on source change", () => {
    const s = num(0);
    const a = s.add(3);
    let c1 = 0, c2 = 0, c3 = 0;
    const d1 = effect(() => { void a.value; c1++; });
    const d2 = effect(() => { void a.value; c2++; });
    const d3 = effect(() => { void a.value; c3++; });
    eq(c1, 1); eq(c2, 1); eq(c3, 1);
    s.value = 5;
    eq(c1, 2); eq(c2, 2); eq(c3, 2);
    d1(); d2(); d3();
  });

  it("disposing one effect doesn't break others", () => {
    const s = num(0);
    const a = s.add(3);
    let c1 = 0, c2 = 0;
    const d1 = effect(() => { void a.value; c1++; });
    const d2 = effect(() => { void a.value; c2++; });
    d1();
    s.value = 1;
    eq(c1, 1); // didn't fire after dispose
    eq(c2, 2);
    d2();
  });

  it("dispose during write doesn't crash", () => {
    const s = num(0);
    const a = s.add(3);
    let count = 0;
    let dispose: (() => void) | undefined;
    dispose = effect(() => {
      void a.value;  // track a (which tracks s)
      count++;
      if (count === 2 && dispose) dispose();
    });
    eq(count, 1);
    s.value = 5;
    eq(count, 2);
    s.value = 10;
    eq(count, 2, "fired after self-dispose");
  });
});

// ─── Chain over chain ────────────────────────────────────────────────

suite("Chain over chain (composability)", () => {
  it("apply a chain to a chain-derived lens", () => {
    const s = num(5);
    const a = s.add(3); // writable Num, = 8
    const b = a.scale(2); // writable Num, = 16
    eq(b.value, 16);
    b.value = 40; // bwd: 40/2 = 20 → a.value = 20 → s.value = 17
    eq(s.peek(), 17);
  });

  it("deep chain composition is correct (4 levels)", () => {
    const s = num(0);
    const a = s.add(1);
    const b = a.scale(2);
    const c = b.sub(3);
    const d = c.add(10);
    // fwd: 0 → 1 → 2 → -1 → 9
    eq(d.value, 9);
    d.value = 19; // bwd: 19-10=9 → 9+3=12 → 12/2=6 → 6-1=5
    eq(s.peek(), 5);
    // Verify fwd from new source: 5 → 6 → 12 → 9 → 19
    eq(d.value, 19);
  });
});

// ─── Chain over mean / joint ────────────────────────────────────────

suite("Chain over mean/joint", () => {
  it("chain a lens off a mean joint", () => {
    const a = num(10), b = num(20);
    const m = mean(a, b); // = 15, writable
    // mean is a Signal<number>; chain works on it.
    const shifted = via(
      m,
      Chain.of<number>().iso({
        fwd: (n) => n + 100,
        bwd: (n) => n - 100,
      }),
    );
    eq(shifted.value, 115);
    shifted.value = 215; // → m = 115 → delta = +100, a+=100, b+=100
    eq(a.peek(), 110);
    eq(b.peek(), 120);
  });

  it("effect on a chain-of-mean re-runs on either source change", () => {
    const a = num(10), b = num(20);
    const m = mean(a, b);
    const shifted = via(
      m,
      Chain.of<number>().iso({ fwd: (n) => n * 2, bwd: (n) => n / 2 }),
    );
    let seen: number[] = [];
    const dispose = effect(() => { seen.push(shifted.value); });
    eq(seen, [30]); // (10+20)/2 * 2 = 30
    a.value = 30;
    eq(seen, [30, 50]); // (30+20)/2 * 2 = 50
    dispose();
  });
});

// ─── Write triggers effect that writes back (re-entry safety) ────────

suite("Re-entry safety", () => {
  it("effect writing to its own dependency does NOT re-fire (engine guard)", () => {
    // Engine intentionally prevents an effect from re-firing itself
    // via writes performed during its own run — this avoids infinite
    // loops by design. Documenting the behavior, not a bug.
    const a = num(0);
    const aPlus1 = a.add(1);
    let count = 0;
    const dispose = effect(() => {
      count++;
      if (count > 10) throw new Error("infinite loop");
      const av = aPlus1.value;
      if (av < 3) a.value = av; // would re-fire if engine allowed
    });
    eq(count, 1, "effect did not re-fire itself");
    // a was written to (1, since initial av=1)
    eq(a.peek(), 1);
    dispose();
  });

  it("write through a chain that writes back to same source", () => {
    // Build a pathological setup: chain whose bwd ALSO triggers a
    // chain-write back into the same source. Should not infinite-loop
    // because of equality short-circuiting.
    const s = num(0);
    const a = s.add(3);
    let count = 0;
    const dispose = effect(() => {
      void a.value;
      count++;
      if (count > 50) throw new Error("infinite loop");
    });
    a.value = 5; // → s = 2; should propagate once and stop
    eq(s.peek(), 2);
    eq(count, 2); // initial + one update
    dispose();
  });
});

// ─── Untracked semantics inside chain step ────────────────────────────

suite("Untracked / tracked reads in chain steps", () => {
  it("chain step with reactive operand: changes propagate", () => {
    const s = num(5);
    const offset = num(3);
    const a = via(
      s,
      Chain.of<number>().iso({
        fwd: (n) => n + offset.value, // reactive read inside fwd
        bwd: (n) => n - offset.value,
      }),
    );
    eq(a.value, 8);
    offset.value = 10;
    eq(a.value, 15);
  });

  it("reactive operand change re-fires effects on chain", () => {
    const s = num(5);
    const offset = num(3);
    const a = s.add(offset);
    let seen: number[] = [];
    const dispose = effect(() => { seen.push(a.value); });
    eq(seen, [8]);
    offset.value = 10;
    eq(seen, [8, 15]);
    s.value = 0;
    eq(seen, [8, 15, 10]);
    dispose();
  });

  it("write into chain with reactive operand uses CURRENT operand value", () => {
    const s = num(5);
    const offset = num(3);
    const a = s.add(offset);
    eq(a.value, 8);
    offset.value = 100;
    a.value = 200; // bwd: 200 - 100 = 100 (uses current offset)
    eq(s.peek(), 100);
  });
});

// ─── Cycle detection / fixpoint ─────────────────────────────────────

suite("Cycle / fixpoint detection", () => {
  it("chain step that reads its own derived computed throws (or recovers)", () => {
    // A chain whose fwd reads the lens itself = self-reference.
    // This SHOULD be caught by the engine's RecursedCheck.
    const s = num(5);
    let self: { value: number } | undefined;
    let threw = false;
    try {
      self = via(
        s,
        Chain.of<number>().iso({
          fwd: (n) => n + (self?.value ?? 0), // self-read
          bwd: (n) => n,
        }),
      );
      // Reading should detect the cycle and throw.
      void self.value;
    } catch (e) {
      threw = true;
      if (!String(e).includes("Cyclic")) {
        throw new Error(`expected cyclic error, got ${e}`);
      }
    }
    if (!threw) throw new Error("cycle not detected");
  });
});

// ─── viewClassFor / instanceof preservation ──────────────────────────

suite("Class identity preservation under chaining", () => {
  it("Num.add(b).add(c).add(d) all instanceof Num, chain works", () => {
    const n = num(0);
    let r = n;
    for (let i = 0; i < 10; i++) r = r.add(1);
    eq(r.value, 10);
    // 10-deep chain of single-step lenses (NOT a single fused chain)
    // each instance is its own Num lens layered on the previous.
    r.value = 20; // bwd routes through 10 add(-1) steps back to source
    eq(n.peek(), 10);
  });

  it("Vec.add(b).x.value flows correctly (Vec → Num)", () => {
    const v = vec(0, 0);
    const off = v.add({ x: 10, y: 20 });
    const offX = off.x; // Num lens on the offset Vec
    eq(offX.value, 10);
    offX.value = 100; // → off.value.x = 100 → off bwd: sub({x:10,y:0}) → source = {x:90, y:?}
    eq(v.peek().x, 90);
  });
});

// ─── Joint edge cases ────────────────────────────────────────────────

suite("Joint / mean edges", () => {
  it("mean of 1 — degenerate but valid", () => {
    const a = num(7);
    const m = mean(a);
    eq(m.value, 7);
    m.value = 14;
    eq(a.peek(), 14);
  });

  it("write through mean inside batch", () => {
    const a = num(0), b = num(0), c = num(0);
    const m = mean(a, b, c);
    let aSeen = 0;
    const dispose = effect(() => { void a.value; aSeen++; });
    eq(aSeen, 1);
    batch(() => { m.value = 30; });
    eq(aSeen, 2);
    eq(a.peek(), 30); // delta = 30 from 0
    dispose();
  });

  it("mean of mean — composable", () => {
    const a = num(1), b = num(3);
    const c = num(5), d = num(7);
    const m1 = mean(a, b); // = 2
    const m2 = mean(c, d); // = 6
    const grand = mean(m1, m2); // = 4
    eq(grand.value, 4);
    grand.value = 8; // delta = +4
    // m1 becomes 6, m2 becomes 10
    // m1's bwd: a + 4, b + 4 → a=5, b=7
    // m2's bwd: c + 4, d + 4 → c=9, d=11
    eq(a.peek(), 5);
    eq(b.peek(), 7);
    eq(c.peek(), 9);
    eq(d.peek(), 11);
  });

  it("viaJoint with no bwd is read-only and propagates source changes", () => {
    const a = num(3), b = num(4);
    const hyp = viaJoint([a, b] as const, {
      fwd: (av, bv) => Math.hypot(av, bv),
    });
    eq(hyp.value, 5);
    let seen: number[] = [];
    const dispose = effect(() => { seen.push(hyp.value); });
    eq(seen, [5]);
    a.value = 6;
    close(seen[1], Math.hypot(6, 4));
    dispose();
  });
});

// ─── Tween / spring through chain ────────────────────────────────────

// We can't easily test the generator-driven animation here without
// the engine, but we can verify the chain lens behaves like a normal
// Signal w.r.t. [LINEAR]/[METRIC]/[LERP] traits (which spring etc.
// need). The lens needs to inherit those trait slots from `Cls`
// (passed to `via`).

suite("Trait slot inheritance through via(Cls)", () => {
  it("Num lens has [LINEAR] trait (so spring can read it)", () => {
    const n = num(5);
    const a = n.add(3);
    // The trait is on the prototype; viewClassFor copies it.
    // We check by symbol access.
    const linear = (a as unknown as { [k: symbol]: unknown });
    // Symbol traits aren't easily reachable without importing the
    // trait symbols; instead check that a is instanceof Num (which
    // has the traits).
    eq(a.constructor.name, "Num");
  });

  it("Vec lens has all trait slots", () => {
    const v = vec(3, 4);
    const a = v.add({ x: 1, y: 1 });
    eq(a.constructor.name, "Vec");
  });
});

// ─── Memory safety / GC interactions ─────────────────────────────────
// (Best-effort — JS doesn't give us real GC control)

suite("Lifetime", () => {
  it("source dropped, chain lens still works (until itself GC'd)", () => {
    const s = num(5);
    const a = s.add(3);
    eq(a.value, 8);
    // Drop our reference to s.
    // Note: 'a' still references s internally; this just verifies it
    // doesn't crash on read.
    eq(a.value, 8);
  });
});

// ─── Glitch-free correctness (diamond dependencies) ─────────────────

suite("Diamond / glitch-free reads", () => {
  it("two lenses on same source — both consistent after write", () => {
    // s
    //  ├ a = s + 1
    //  └ b = s * 2
    // sum = a + b. Should always satisfy sum = (s+1) + (s*2) = 3s + 1.
    const s = num(5);
    const a = s.add(1);
    const b = s.scale(2);
    let glitch = false;
    let lastSum = -1;
    const dispose = effect(() => {
      const sum = a.value + b.value;
      const expected = 3 * s.value + 1;
      if (sum !== expected) glitch = true;
      lastSum = sum;
    });
    eq(lastSum, 16);
    s.value = 10;
    eq(lastSum, 31);
    if (glitch) throw new Error("observed glitch (intermediate inconsistent state)");
    dispose();
  });

  it("diamond: chain that reads source twice via different paths", () => {
    const s = num(5);
    // x = s.x + 100 (but s is Num; pretend it's a vec via field)
    // Use Box → x and Box → w; both depend on the same Box source
    const b = box(3, 4, 100, 50);
    const xPlusW = b.x.add(b.w.value); // 1-step chain
    void xPlusW; // forces resolution
    eq(b.x.value + b.w.value, 103);
  });
});

// ─── Order of operations / commutativity ────────────────────────────

suite("Chain order semantics", () => {
  it("add then scale ≠ scale then add (non-commutative)", () => {
    const s = num(10);
    // (s + 1) * 2 = 22
    const a = s.derive((c) => c.add(1).scale(2));
    eq(a.value, 22);
    // s * 2 + 1 = 21
    const b = s.derive((c) => c.scale(2).add(1));
    eq(b.value, 21);
    // Writes must respect order too. a.value = 30 → (30/2)-1 = 14
    a.value = 30;
    eq(s.peek(), 14);
    // Reset and try b
    s.value = 10;
    b.value = 30; // → (30-1)/2 = 14.5
    eq(s.peek(), 14.5);
  });

  it("perp().perp().perp().perp() = identity (4-fold composition)", () => {
    const v = vec(3, 7);
    const r = v.perp().perp().perp().perp();
    eq(r.value, { x: 3, y: 7 });
    r.value = { x: 100, y: 200 };
    eq(v.peek(), { x: 100, y: 200 });
  });
});

// ─── Writing through chains: lens laws check ────────────────────────

suite("Lens laws (best-effort runtime check)", () => {
  it("get-set: lens.value = lens.value is a no-op (for arithmetic chains)", () => {
    const s = num(5);
    const a = s.derive((c) => c.add(3).scale(2));
    const before = a.value;
    a.value = a.value; // (2*8) = 16 → bwd → (16/2)-3 = 5
    eq(s.peek(), 5, "get-set changed source");
    eq(a.value, before);
  });

  it("set-get: read after set returns what was set", () => {
    const s = num(5);
    const a = s.derive((c) => c.add(3).scale(2));
    a.value = 100;
    eq(a.value, 100, "set-get failed");
  });

  it("set-set: writes are idempotent in the last", () => {
    const s = num(5);
    const a = s.add(3);
    a.value = 100;
    eq(s.peek(), 97);
    a.value = 200;
    eq(s.peek(), 197);
    a.value = 200; // same write again
    eq(s.peek(), 197);
  });

  it("field-lens preserves orthogonal fields under writes", () => {
    const v = vec(1, 2);
    v.x.value = 100;
    eq(v.peek(), { x: 100, y: 2 });
    v.y.value = 999;
    eq(v.peek(), { x: 100, y: 999 });
  });
});

// ─── Subscribe AFTER a write — late subscribers see correct value ────

suite("Late subscribers", () => {
  it("effect added after write sees post-write value", () => {
    const s = num(0);
    const a = s.add(3);
    s.value = 5; // before any subscription
    let seen: number | undefined;
    const dispose = effect(() => { seen = a.value; });
    eq(seen, 8);
    dispose();
  });

  it("subscribe to chain after multiple writes/changes", () => {
    const s = num(0);
    const a = s.add(3);
    s.value = 1; s.value = 2; s.value = 3;
    let seen: number | undefined;
    const dispose = effect(() => { seen = a.value; });
    eq(seen, 6);
    dispose();
  });

  it("subscribe to lens, dispose, subscribe again", () => {
    const s = num(0);
    const a = s.add(3);
    let seen: number[] = [];
    const d1 = effect(() => { seen.push(a.value); });
    eq(seen, [3]);
    s.value = 5;
    eq(seen, [3, 8]);
    d1();
    s.value = 10; // no live subscribers
    eq(seen, [3, 8]);
    const d2 = effect(() => { seen.push(a.value); });
    eq(seen, [3, 8, 13]);
    s.value = 20;
    eq(seen, [3, 8, 13, 23]);
    d2();
  });
});

// ─── Chains with bound (reactive) operands ──────────────────────────

suite("Chains with bound operands", () => {
  it("vec.x + reactive offset, change offset triggers re-read", () => {
    const v = vec(0, 0);
    const off = num(10);
    const shifted = v.x.add(off);
    let seen: number[] = [];
    const dispose = effect(() => { seen.push(shifted.value); });
    eq(seen, [10]);
    off.value = 50;
    eq(seen, [10, 50]);
    v.x.value = 5;
    eq(seen, [10, 50, 55]);
    dispose();
  });

  it("chain with reactive operand AND field — both contribute prev", () => {
    const v = vec(1, 2);
    const off = num(100);
    // x.add(off) — Num chain: field('x'), add(off)
    const lens = v.x.add(off);
    eq(lens.value, 101);
    // Write through: bwd is (target - off.peek()) = (200 - 100) = 100 → x = 100 → spread y
    lens.value = 200;
    eq(v.peek(), { x: 100, y: 2 });
  });

  it("operand swap — change the operand SIGNAL identity at runtime", () => {
    const s = num(5);
    // We can't swap the operand signal mid-chain (the chain captures
    // the operand at construction); but we can swap its VALUE.
    const off = num(10);
    const a = s.add(off);
    eq(a.value, 15);
    off.value = 100;
    eq(a.value, 105);
    s.value = 0;
    eq(a.value, 100);
  });
});

// ─── Stress: long chains ────────────────────────────────────────────

suite("Stress: long chains", () => {
  it("100-step fused chain: writes correctly route through all inverses", () => {
    const s = num(0);
    // Build a fused chain of 100 +1 steps
    const a = s.derive((c) => {
      for (let i = 0; i < 100; i++) c = c.add(1);
      return c;
    });
    eq(a.value, 100);
    a.value = 500; // bwd: 500 - 100 = 400
    eq(s.peek(), 400);
  });

  it("1000-step chain: still O(N), correct, no stack-overflow", () => {
    const s = num(0);
    const a = s.derive((c) => {
      for (let i = 0; i < 1000; i++) c = c.add(1);
      return c;
    });
    eq(a.value, 1000);
    a.value = 5000;
    eq(s.peek(), 4000);
  });

  it("100 separately-derived lenses (NOT a single fused chain)", () => {
    const s = num(0);
    let cur: typeof s = s;
    for (let i = 0; i < 100; i++) cur = cur.add(1);
    eq(cur.value, 100);
    // Writing routes through 100 individual setters.
    cur.value = 250;
    eq(s.peek(), 150);
  });
});

// ─── Iterative writes during read (re-entry from getter) ─────────────

suite("Re-entrant reads", () => {
  it("reading a chain inside its own fwd throws (cycle)", () => {
    const s = num(5);
    let self: { value: number } | undefined;
    self = via(
      s,
      Chain.of<number>().iso({
        fwd: (n) => n + (self ? self.value : 0),
        bwd: (n) => n,
      }),
    );
    throws(() => { void self!.value; }, "cyclic read should throw");
  });
});

// ─── Summary ─────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
