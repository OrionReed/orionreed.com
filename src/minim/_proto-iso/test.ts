// Runtime smoke tests for the invertible-chain prototype. Hand-rolled
// (no vitest dep) so we can run as a script.
//
// Run: npx vite-node src/minim/_proto-iso/test.ts

import { Signal } from "../signals/signal";
import { effect } from "../signals/signal";
import { Chain, via } from "./iso";
import { field } from "./field";
import { mean, viaJoint } from "./joint";
import { Num, num } from "./num";
import { Vec, vec } from "./vec";
import { Box, box } from "./box";

let passed = 0;
let failed = 0;

function suite(name: string, fn: () => void) {
  console.log(`\n— ${name}`);
  fn();
}
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`     ${(e as Error).message}`);
  }
}
function eq<T>(a: T, b: T, msg?: string) {
  if (typeof a === "object" && a !== null) {
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

// ─── Iso basics ───────────────────────────────────────────────────────

suite("Chain / via — single-source", () => {
  it("empty chain is identity (writable)", () => {
    const s = new Signal(5);
    const v = via(s, Chain.of<number>());
    eq(v.value, 5);
    v.value = 10;
    eq(s.peek(), 10);
  });

  it("single iso step: add — bidirectional", () => {
    const s = new Signal(5);
    const v = via(s, Chain.of<number>().iso({
      fwd: (n) => n + 3,
      bwd: (n) => n - 3,
    }));
    eq(v.value, 8);
    v.value = 20;
    eq(s.peek(), 17);
  });

  it("chain of 3 invertible steps composes inverses", () => {
    const s = new Signal(0);
    const c = Chain.of<number>()
      .iso({ fwd: (n) => n + 10, bwd: (n) => n - 10 })
      .iso({ fwd: (n) => n * 2,  bwd: (n) => n / 2 })
      .iso({ fwd: (n) => n - 5,  bwd: (n) => n + 5 });
    const v = via(s, c);
    eq(v.value, 15);             // 0 → 10 → 20 → 15
    v.value = 25;                // 25 → 30 → 15 → 5
    eq(s.peek(), 5);
  });

  it(".ro step downgrades chain; writes throw at type level (runtime: just no-op)", () => {
    const s = new Signal(2);
    const c = Chain.of<number>().ro({ fwd: (n) => n * n });
    const v = via(s, c);
    eq(v.value, 4);
    // Runtime: read-only Computed has no setter; assigning throws.
    throws(() => { (v as unknown as { value: number }).value = 9; }, "read-only Computed should throw on write");
  });
});

// ─── Field iso ────────────────────────────────────────────────────────

suite("field iso", () => {
  it("field as a stock iso composes with arithmetic", () => {
    const box = new Signal<{ x: number; y: number }>({ x: 0, y: 5 });
    const c = Chain.of<{ x: number; y: number }>()
      .iso(field<{ x: number; y: number }, "x">("x"))
      .iso({ fwd: (n: number) => n + 10, bwd: (n: number) => n - 10 });
    const v = via(box, c);
    eq(v.value, 10);
    v.value = 25; // → field bwd: x becomes 15 → record becomes {x:15, y:5}
    eq(box.peek(), { x: 15, y: 5 });
  });
});

// ─── Num port ─────────────────────────────────────────────────────────

suite("Num port", () => {
  it("num.add(b) is writable, distributes back", () => {
    const n = num(5);
    const a = n.add(3);
    eq(a.value, 8);
    a.value = 20;
    eq(n.peek(), 17);
  });

  it("num.scale(2).add(1) — fused, writable", () => {
    const n = num(5);
    const m = n.derive((c) => c.scale(2).add(1));
    eq(m.value, 11);
    m.value = 21; // (21 - 1) / 2 = 10
    eq(n.peek(), 10);
  });

  it("num.clamp is read-only", () => {
    const n = num(50);
    const c = n.clamp(0, 100);
    eq(c.value, 50);
    throws(() => { (c as unknown as { value: number }).value = 25; });
    n.value = 200;
    eq(c.value, 100); // still clamps reads
  });

  it("num.add(3).clamp(0, 100) — fused, read-only (degraded)", () => {
    const n = num(5);
    const d = n.derive((c) => c.add(3).clamp(0, 100));
    eq(d.value, 8);
    n.value = 200;
    eq(d.value, 100); // clamps
    throws(() => { (d as unknown as { value: number }).value = 50; });
  });

  it("num.add(b) reflects reactive b changes", () => {
    const n = num(5);
    const off = num(3);
    const a = n.add(off);
    eq(a.value, 8);
    off.value = 10;
    eq(a.value, 15);
  });
});

// ─── Vec port ─────────────────────────────────────────────────────────

suite("Vec port", () => {
  it("vec.x writable lens distributes through to source", () => {
    const v = vec(3, 4);
    eq(v.x.value, 3);
    v.x.value = 100;
    eq(v.peek(), { x: 100, y: 4 });
  });

  it("vec.add({x,y}) is writable (Vec); writes solve back", () => {
    const v = vec(1, 2);
    const a = v.add({ x: 10, y: 20 });
    eq(a.value, { x: 11, y: 22 });
    a.value = { x: 100, y: 200 };
    eq(v.peek(), { x: 90, y: 180 });
  });

  it("vec.right(w).down(h) — composes shifts, writable", () => {
    const v = vec(0, 0);
    const corner = v.right(10).down(20);
    eq(corner.value, { x: 10, y: 20 });
    corner.value = { x: 110, y: 220 };
    eq(v.peek(), { x: 100, y: 200 });
  });

  it("vec.derive(c => c.right(w).down(h).x) — Vec→Num chain, writable", () => {
    const v = vec(0, 0);
    const rightX = v.deriveNum((c) => c.right(50).x);
    eq(rightX.value, 50);
    rightX.value = 200;
    eq(v.peek(), { x: 150, y: 0 }); // x' = 200 - 50; y unchanged
  });

  it("vec.distance(other) is read-only", () => {
    const v = vec(3, 4);
    const d = v.distance({ x: 0, y: 0 });
    eq(d.value, 5);
    throws(() => { (d as unknown as { value: number }).value = 10; });
  });

  it("vec.magnitude is read-only", () => {
    const v = vec(3, 4);
    eq(v.magnitude.value, 5);
    throws(() => { (v.magnitude as unknown as { value: number }).value = 10; });
  });

  it("vec.perp() is writable (its own explicit inverse)", () => {
    const v = vec(3, 4);
    const p = v.perp();
    eq(p.value, { x: 4, y: -3 });
    p.value = { x: -1, y: 2 };  // back: y=-1, x=2 → wait, perp⁻¹(v)=(-v.y, v.x), so source = (-2, -1)
    eq(v.peek(), { x: -2, y: -1 });
  });

  it("vec.derive(c => c.normalize()) is read-only (info loss)", () => {
    const v = vec(3, 4);
    const u = v.derive((c) => c.normalize());
    close(u.value.x, 0.6, 1e-9);
    close(u.value.y, 0.8, 1e-9);
    throws(() => { (u as unknown as { value: { x: number; y: number } }).value = { x: 0, y: 1 }; });
  });
});

// ─── Box port (4-component value type) ────────────────────────────────

suite("Box port", () => {
  it("box.x is writable Num lens (field iso)", () => {
    const b = box(10, 20, 100, 50);
    eq(b.x.value, 10);
    b.x.value = 99;
    eq(b.peek(), { x: 99, y: 20, w: 100, h: 50 });
  });

  it("box.at(0.5, 0.5) — anchor center; writable", () => {
    const b = box(0, 0, 100, 50);
    const c = b.center;
    eq(c.value, { x: 50, y: 25 });
    c.value = { x: 200, y: 100 }; // size preserved, position shifted
    eq(b.peek(), { x: 150, y: 75, w: 100, h: 50 });
  });

  it("box.at(0, 0) — top-left; writable", () => {
    const b = box(10, 20, 100, 50);
    const tl = b.at(0, 0);
    eq(tl.value, { x: 10, y: 20 });
    tl.value = { x: 0, y: 0 };
    eq(b.peek(), { x: 0, y: 0, w: 100, h: 50 });
  });

  it("box.at(1, 1) — bottom-right; writable", () => {
    const b = box(0, 0, 100, 50);
    const br = b.at(1, 1);
    eq(br.value, { x: 100, y: 50 });
    br.value = { x: 200, y: 100 };
    eq(b.peek(), { x: 100, y: 50, w: 100, h: 50 });
  });

  it("box.expand(10).area is read-only Num (chain of invertible + ro)", () => {
    const b = box(0, 0, 100, 50);
    const a = b.deriveNum((c) => c.expand(10).area);
    eq(a.value, 120 * 70); // expanded box's area
    throws(() => { (a as unknown as { value: number }).value = 0; });
  });

  it("box.expand(n) is writable through both directions", () => {
    const b = box(0, 0, 100, 50);
    const e = b.expand(10);
    eq(e.value, { x: -10, y: -10, w: 120, h: 70 });
    e.value = { x: 0, y: 0, w: 200, h: 100 }; // bwd: contract by 10
    eq(b.peek(), { x: 10, y: 10, w: 180, h: 80 });
  });

  it("box.deriveVec(c => c.at(0.5, 0).x) — 3-stage chain Box→Vec→Num, writable", () => {
    const b = box(0, 0, 100, 50);
    const cx = b.deriveNum((c) => c.at(0.5, 0).x);
    eq(cx.value, 50);
    cx.value = 200; // box.x shifts so center-x = 200
    eq(b.peek().x, 150);
  });
});

// ─── md-layout-demo proof: hand-rolled lens collapses ────────────────

suite("md-layout-demo collapse", () => {
  it("handle anchor: card-translate + (w, h/2), writable through w", () => {
    // Mimic the call site: a card's translate Vec, an independent w Num,
    // a static h. We want the handle's position to be a Vec lens such
    // that:
    //   read:  translate + (w, h/2)
    //   write: solves back to w (translate stays put per the demo)
    const card = vec(50, 50);
    const w = num(80);
    const h = 60;

    // Today's spelling: derived(Vec, get, set) hand-rolled.
    // Tomorrow's spelling: composition of writable axis lenses + offsets.
    // Here we model "x = card.x + w" (writable through w) plus "y =
    // card.y + h/2" (static offset).
    //
    // Building it explicitly to show the collapse: we couldn't quite
    // type a single chain for this (it has two axes with different
    // dependencies), but the building blocks now compose:

    // x-axis lens: writable through w; reads (card.x + w).
    const xLens = card.x.derive((c) => c.add(w));
    // y-axis lens: writable through card.y; reads (card.y + h/2).
    const yLens = card.y.derive((c) => c.add(h / 2));

    eq(xLens.value, 130);  // 50 + 80
    eq(yLens.value, 80);   // 50 + 30

    // Simulate dragging the handle: write to xLens flows back to w
    // (card.x stays put because xLens is rooted at card.x, but the
    // INVERSE is "x - w from card", and w is what's reactive in `add`).
    // Actually: xLens = card.x.add(w). Setter: card.x = next - w.peek().
    // So writing xLens does shift card.x — same as in the demo's setter
    // path (which clamps w, not card.x).
    //
    // To get the demo's exact semantics (write x → adjust w, not card.x),
    // we'd want the chain to be rooted at w with .add(card.x). That's
    // the inverted spelling — and it works:
    const xViaW = w.derive((c) => c.add(card.x));
    eq(xViaW.value, 130);
    xViaW.value = 200;
    eq(w.peek(), 150); // 200 - 50 = 150 (card.x stays)
    eq(card.peek().x, 50);
  });
});

// ─── Joint / mean ────────────────────────────────────────────────────

suite("Joint / mean", () => {
  it("mean(a, b, c) reads as average, writes distribute delta", () => {
    const a = num(10), b = num(20), c = num(30);
    const m = mean(a, b, c);
    eq(m.value, 20);
    m.value = 50; // delta = +30, spread evenly: a+30, b+30, c+30
    eq(a.peek(), 40);
    eq(b.peek(), 50);
    eq(c.peek(), 60);
  });

  it("mean over Vecs", () => {
    const a = vec(0, 0), b = vec(10, 10);
    const m = mean(a, b);
    eq(m.value, { x: 5, y: 5 });
    m.value = { x: 100, y: 100 };
    eq(a.peek(), { x: 95, y: 95 });
    eq(b.peek(), { x: 105, y: 105 });
  });

  it("read-only joint via viaJoint without bwd", () => {
    const a = num(3), b = num(4);
    const hyp = viaJoint([a, b] as const, {
      fwd: (av, bv) => Math.hypot(av, bv),
    });
    eq(hyp.value, 5);
    throws(() => { (hyp as unknown as { value: number }).value = 13; });
  });
});

// ─── Reactivity propagation through chains ───────────────────────────

suite("Reactivity (effect re-runs on upstream change)", () => {
  it("effect on lens re-runs when source updates", () => {
    const n = num(1);
    const doubled = n.scale(2);
    let saw: number[] = [];
    const dispose = effect(() => { saw.push(doubled.value); });
    eq(saw, [2]);
    n.value = 5;
    eq(saw, [2, 10]);
    n.value = 10;
    eq(saw, [2, 10, 20]);
    dispose();
  });

  it("write through lens propagates to source's other subscribers", () => {
    const n = num(1);
    const a = n.scale(2);          // writable lens
    let saw: number[] = [];
    const dispose = effect(() => { saw.push(n.value); });
    eq(saw, [1]);
    a.value = 10;                  // → n = 5
    eq(saw, [1, 5]);
    dispose();
  });

  it("nested chain reflects reactive operand changes", () => {
    const n = num(0);
    const k = num(2);
    const m = n.derive((c) => c.add(3).scale(k));
    eq(m.value, 6); // (0+3)*2
    n.value = 5;
    eq(m.value, 16); // (5+3)*2
    k.value = 10;
    eq(m.value, 80); // (5+3)*10
  });
});

// ─── Class identity (Cls passthrough) ────────────────────────────────

suite("class identity", () => {
  it("vec.add(...) is instanceof Vec (chained methods work)", () => {
    const v = vec(0, 0);
    const a = v.add({ x: 1, y: 2 });
    if (!(a instanceof Vec)) throw new Error(`expected Vec, got ${(a as object).constructor.name}`);
    const a2 = a.add({ x: 10, y: 20 });
    eq(a2.value, { x: 11, y: 22 });
  });

  it("num.add(...) is instanceof Num", () => {
    const n = num(0);
    const a = n.add(5);
    if (!(a instanceof Num)) throw new Error(`expected Num, got ${(a as object).constructor.name}`);
  });
});

// ─── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
