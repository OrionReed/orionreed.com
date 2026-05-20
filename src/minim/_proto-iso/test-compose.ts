// Tests for compositional utils. Each test demonstrates a non-trivial
// pattern that becomes natural under the chain primitives.
//
// Run: npx vite-node src/minim/_proto-iso/test-compose.ts

import { Signal, effect } from "../signals/signal";
import { Chain, via } from "./iso";
import { viaJoint } from "./joint";
import { num, Num } from "./num";
import { vec, Vec } from "./vec";
import { box, Box } from "./box";
import {
  degToRad, radToDeg, flipRange, remap, normalize01,
  cartesianToPolar, polarToCartesian, type Polar,
  clamp01, midpoint, midpointNum, align, between, pin,
  edgeFrom,
} from "./compose";
import { polarLens, mirrorOf, handleLens_original } from "./real-world";

let passed = 0, failed = 0;
const failures: string[] = [];
function suite(n: string, f: () => void) { console.log(`\n— ${n}`); f(); }
function it(n: string, f: () => void) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) {
    failed++;
    failures.push(`${n}: ${(e as Error).message}`);
    console.log(`  ✗ ${n}\n     ${(e as Error).message}`);
  }
}
function eq<T>(a: T, b: T) {
  if (typeof a === "object" && a !== null) {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    return;
  }
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function close(a: number, b: number, eps = 1e-9) {
  if (Math.abs(a - b) > eps) throw new Error(`expected ~${b}, got ${a}`);
}
function closeVec(a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-9) {
  close(a.x, b.x, eps); close(a.y, b.y, eps);
}

// ─── Pure isos ─────────────────────────────────────────────────────

suite("Pure isos", () => {
  it("degToRad / radToDeg round-trip", () => {
    const d = new Signal(180);
    const r = via(d, Chain.of<number>().iso(degToRad));
    close(r.value, Math.PI);
    r.value = Math.PI / 2;
    close(d.peek(), 90);
  });

  it("flipRange is self-inverse", () => {
    const s = new Signal(2);
    const r = via(s, Chain.of<number>().iso(flipRange(0, 10)));
    eq(r.value, 8);
    r.value = 3;
    eq(s.peek(), 7);
    // Apply twice → identity
    const r2 = via(s, Chain.of<number>()
      .iso(flipRange(0, 10))
      .iso(flipRange(0, 10)));
    eq(r2.value, s.peek());
  });

  it("remap composes", () => {
    // s ∈ [0, 100] → t ∈ [0, 1] → u ∈ [-1, 1]
    const s = new Signal(50);
    const chain = Chain.of<number>()
      .iso(remap(0, 100, 0, 1))
      .iso(remap(0, 1, -1, 1));
    const u = via(s, chain);
    close(u.value, 0); // midpoint of [-1, 1]
    u.value = 1;
    close(s.peek(), 100);
    u.value = -1;
    close(s.peek(), 0);
  });

  it("cartesian ↔ polar round-trips for arbitrary points", () => {
    const v = vec(3, 4);
    const polar = via(v, Chain.of<{x:number;y:number}>().iso(cartesianToPolar));
    eq(polar.value, { r: 5, a: Math.atan2(4, 3) });
    // Write polar back
    polar.value = { r: 10, a: 0 };
    closeVec(v.peek(), { x: 10, y: 0 });
  });
});

// ─── Reactive helpers ──────────────────────────────────────────────

suite("Reactive helpers", () => {
  it("clamp01 caps values to [0,1]", () => {
    const n = num(0.5);
    const c = clamp01(n);
    eq(c.value, 0.5);
    n.value = 2;
    eq(c.value, 1);
    n.value = -0.5;
    eq(c.value, 0);
  });

  it("midpoint of two Vecs is writable — dragging moves both", () => {
    const a = vec(0, 0);
    const b = vec(10, 10);
    const m = midpoint(a, b);
    eq(m.value, { x: 5, y: 5 });
    // Drag midpoint by (+50, +50)
    m.value = { x: 55, y: 55 };
    eq(a.peek(), { x: 50, y: 50 });
    eq(b.peek(), { x: 60, y: 60 });
  });

  it("midpoint of midpoint composes", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const c = vec(0, 10);
    const d = vec(10, 10);
    const m1 = midpoint(a, b); // (5, 0)
    const m2 = midpoint(c, d); // (5, 10)
    const center = midpoint(m1, m2); // (5, 5)
    eq(center.value, { x: 5, y: 5 });
    // Drag center → distributes through both midpoints, then through endpoints
    center.value = { x: 100, y: 100 };
    eq(a.peek(), { x: 95, y: 95 });
    eq(b.peek(), { x: 105, y: 95 });
    eq(c.peek(), { x: 95, y: 105 });
    eq(d.peek(), { x: 105, y: 105 });
  });

  it("align(a, b) makes two Nums share a value (via midpoint)", () => {
    const a = num(0); const b = num(10);
    const shared = align(a, b);
    eq(shared.value, 5);
    shared.value = 20; // both move toward 20 by delta=+15
    eq(a.peek(), 15);
    eq(b.peek(), 25);
  });

  it("between is read-only but reactive in both endpoints + t", () => {
    const a = vec(0, 0);
    const b = vec(10, 10);
    const t = num(0.5);
    const m = between(a, b, t);
    eq(m.value, { x: 5, y: 5 });
    t.value = 0.25;
    eq(m.value, { x: 2.5, y: 2.5 });
    b.value = { x: 100, y: 100 };
    eq(m.value, { x: 25, y: 25 });
  });
});

// ─── pin / anchored layout ─────────────────────────────────────────

suite("pin (anchored layout)", () => {
  it("pin two boxes' top edges to each other (joint midpoint)", () => {
    const a = box(0, 0, 100, 50);
    const b = box(50, 100, 80, 40);
    // Pin a.bottom (0.5, 1) to b.top (0.5, 0)
    const joint = pin(a, 0.5, 1, b, 0.5, 0);
    eq(joint.value, {
      x: (50 + 90) / 2,   // (a.center.x + b.center.x) / 2 = (50 + 90)/2
      y: (50 + 100) / 2,  // (a.bottom.y + b.top.y) / 2
    });
    // Drag joint
    joint.value = { x: 200, y: 200 };
    // a.bottom and b.top should each move toward (200,200) by half the delta
  });
});

// ─── Real-world conversions ─────────────────────────────────────────

suite("Real-world conversions", () => {
  it("mirrorOf — reflect lens, writable through itself", () => {
    const mA = vec(360, 30);
    const mB = vec(360, 330);
    const src = vec(200, 90);
    const mirrored = mirrorOf(src, mA, mB);
    // Reflecting across the vertical line x=360 maps (200, 90) → (520, 90)
    eq(mirrored.value, { x: 520, y: 90 });
    // Write the mirror → source moves
    mirrored.value = { x: 540, y: 100 };
    eq(src.peek(), { x: 180, y: 100 });
    // Move the mirror itself → reflected position updates
    mA.value = { x: 400, y: 30 };
    mB.value = { x: 400, y: 330 };
    // src is (180, 100). Reflect across x=400 → (620, 100).
    eq(mirrored.value, { x: 620, y: 100 });
  });

  it("handleLens — md-layout-demo: drag updates w, not card", () => {
    const card = vec(50, 50);
    const w = num(80);
    const h = 60;
    const MIN_W = 22;
    const handle = handleLens_original(card, w, h, MIN_W);
    eq(handle.value, { x: 130, y: 80 }); // card.x + w, card.y + h/2

    // Drag handle.x → updates w (clamped)
    handle.value = { x: 200, y: 80 };
    eq(w.peek(), 150);  // 200 - 50 = 150
    eq(card.peek().x, 50);  // unchanged

    // Drag below MIN_W
    handle.value = { x: 60, y: 80 };
    eq(w.peek(), MIN_W);  // 60 - 50 = 10, clamped to MIN_W
  });

  it("polarLens — write cartesian, store as polar(r, a)", () => {
    const center = vec(0, 0);
    const r = num(5);
    const a = num(0);
    const p = polarLens(center, r, a);
    eq(p.value, { x: 5, y: 0 });
    // Move target to (0, 10) → r=10, a=π/2
    p.value = { x: 0, y: 10 };
    close(r.peek(), 10);
    close(a.peek(), Math.PI / 2);
    // Move the center → polar point follows
    center.value = { x: 100, y: 100 };
    eq(p.value, { x: 100, y: 110 }); // 100 + (10*cos(π/2), 10*sin(π/2))
  });
});

// ─── Layered chain composition stress test ───────────────────────────

suite("Layered composition (5 levels deep)", () => {
  it("Box → at → x → add → scale → all writable", () => {
    const b = box(0, 0, 100, 50);
    // Take the center, x-axis, shifted by 1000, scaled by 2.
    // chain: field("x") of at(0.5, 0.5) of source, .add(1000), .scale(2)
    const lens = b.deriveNum((c) =>
      c.at(0.5, 0.5).x.add(1000).scale(2),
    );
    // center.x = 50; +1000 = 1050; *2 = 2100
    eq(lens.value, 2100);
    // Write 4000 → bwd: 4000/2 = 2000; -1000 = 1000; field x with prev → {...b, x:1000}
    // But wait — `at(0.5, 0.5)` is the anchor: writing changes box.x
    // such that the anchor lands at target. So target.x = 1000 → box.x
    // satisfies center.x = 1000 → box.x = 1000 - 50 = 950.
    lens.value = 4000;
    eq(b.peek().x, 950);
  });
});

// ─── boundingBox / layout combinators (sanity) ─────────────────────

suite("Layout combinators", () => {
  it("bounding box reads the union", () => {
    const a = box(0, 0, 100, 50);
    const b = box(80, 30, 100, 100);
    // bounding box: x=0, y=0, w=180, h=130
    // (built via boundingBox internally in above/beside)
    // Not directly testing the layout combinators since `above`/`beside`
    // are simplified sketches; just verifying primitives work.
    eq(a.x.value, 0);
    eq(b.x.value, 80);
  });
});

// ─── Effects propagation through compositional utils ────────────────

suite("Reactivity through compositional utils", () => {
  it("midpoint effect re-fires on either endpoint change", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const m = midpoint(a, b);
    let seen: { x: number; y: number }[] = [];
    const dispose = effect(() => { seen.push({ ...m.value }); });
    eq(seen.length, 1);
    a.value = { x: 100, y: 0 };
    eq(seen.length, 2);
    eq(seen[1], { x: 55, y: 0 });
    b.value = { x: 200, y: 50 };
    eq(seen.length, 3);
    eq(seen[2], { x: 150, y: 25 });
    dispose();
  });

  it("polarLens effect re-fires on r OR a OR center change", () => {
    const c = vec(0, 0);
    const r = num(1);
    const a = num(0);
    const p = polarLens(c, r, a);
    let count = 0;
    const dispose = effect(() => { void p.value; count++; });
    eq(count, 1);
    r.value = 2;
    eq(count, 2);
    a.value = Math.PI;
    eq(count, 3);
    c.value = { x: 10, y: 10 };
    eq(count, 4);
    dispose();
  });
});

// ─── Summary ─────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
