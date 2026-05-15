// Behavior tests — verify spring/oscillate/attract/drift work across
// Num, Vec, and Transform via composite capability dispatch.
//
// Each behavior is a generator that yields per frame. We drive them
// manually via `.next(dt)` to test without setting up the full Anim
// runtime.

import { spring, oscillate, attract, drift } from "./behaviors";
import { Num, Vec, Transform, type V, type Tr } from "./values";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ""}`); }
}
function section(s: string): void { console.log(`\n── ${s} ────────────────────────`); }

/** Run a behavior generator until it returns OR `maxFrames` is hit.
 *  Returns whether it settled. */
function runUntilDone<T>(
  gen: Generator<unknown, T, number>,
  dt: number,
  maxFrames: number,
): { settled: boolean; frames: number } {
  // Generators yield `undefined` for "wait one frame"; we feed dt back.
  // First `.next()` runs until the first yield (no dt needed yet).
  gen.next();
  for (let i = 0; i < maxFrames; i++) {
    const r = gen.next(dt);
    if (r.done) return { settled: true, frames: i + 1 };
  }
  return { settled: false, frames: maxFrames };
}

// ── Drift ───────────────────────────────────────────────────────────

section("drift");
{
  const x = Num(0);
  const g = drift(x, 10);  // 10 units/sec
  runUntilDone(g, 0.1, 5);  // 5 frames * 0.1s = 0.5s — expect ~5 units
  check("drift moves at constant velocity",
    Math.abs(x() - 5) < 0.01, x());
}
{
  const v = Vec({ x: 0, y: 0 });
  const g = drift(v, { x: 1, y: 2 });  // 1 unit/s in x, 2 in y
  runUntilDone(g, 0.5, 4);  // 4 frames * 0.5s = 2s
  check("drift<Vec> moves both axes",
    Math.abs(v().x - 2) < 0.01 && Math.abs(v().y - 4) < 0.01,
    v());
}

// ── Attract ─────────────────────────────────────────────────────────

section("attract");
{
  const x = Num(0);
  const g = attract(x, 100, 2);  // k=2: ~86% closed in 1s
  runUntilDone(g, 0.01, 200);  // 2 simulated seconds
  check("attract converges toward target",
    Math.abs(x() - 100) < 5, x());
}

// ── Oscillate ───────────────────────────────────────────────────────

section("oscillate");
{
  const x = Num(0);
  const g = oscillate(x, 10, 1);  // amp=10, freq=1Hz
  // After 0 frames (initial yield), value is still 0 (the closure
  // captures base but no frame has fired yet).
  g.next();   // wind to first yield
  g.next(0.25);  // t = 0.25s: sin(π/2) = 1 → 0 + 10*1 = 10
  check("oscillate at t=0.25 → +amp",
    Math.abs(x() - 10) < 0.01, x());
  g.next(0.25);  // t = 0.5s: sin(π) = 0
  check("oscillate at t=0.5 → 0",
    Math.abs(x()) < 0.01, x());
  g.next(0.25);  // t = 0.75s: sin(3π/2) = -1 → 0 + 10*(-1) = -10
  check("oscillate at t=0.75 → -amp",
    Math.abs(x() - (-10)) < 0.01, x());
}

// ── Spring ──────────────────────────────────────────────────────────

section("spring (Num)");
{
  const x = Num(0);
  const g = spring(x, 100, { stiffness: 100, damping: 20, precision: 0.01 });
  const r = runUntilDone(g, 0.016, 1000);  // 60fps, up to 16s
  check("spring settles on target", r.settled);
  check("spring final position near target",
    Math.abs(x() - 100) < 0.1, x());
}

section("spring (Vec)");
{
  const v = Vec({ x: 0, y: 0 });
  const g = spring(v, { x: 50, y: 30 } as V, {
    stiffness: 100, damping: 20, precision: 0.01,
  });
  const r = runUntilDone(g, 0.016, 1000);
  check("spring<Vec> settles", r.settled);
  check("spring<Vec> reaches target",
    Math.abs(v().x - 50) < 0.5 && Math.abs(v().y - 30) < 0.5,
    v());
}

section("spring (Transform — composite-capability dispatch)");
{
  const tr = Transform({
    translate: { x: 0, y: 0 }, rotate: 0,
    scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 1,
  });
  const targetTr: Tr = {
    translate: { x: 100, y: 100 }, rotate: Math.PI / 2,
    scale: { x: 2, y: 2 }, origin: { x: 0, y: 0 }, opacity: 0,
  };
  const g = spring(tr, targetTr, {
    stiffness: 100, damping: 20, precision: 0.01,
  });
  const r = runUntilDone(g, 0.016, 1000);
  check("spring<Transform> settles via composite linear+metric",
    r.settled);
  check("spring<Transform> translate close",
    Math.abs(tr().translate.x - 100) < 1,
    tr().translate);
  check("spring<Transform> rotate close",
    Math.abs(tr().rotate - Math.PI / 2) < 0.05,
    tr().rotate);
  check("spring<Transform> opacity close",
    Math.abs(tr().opacity - 0) < 0.05,
    tr().opacity);
}

// ── Reactive target ─────────────────────────────────────────────────

section("reactive target — chase a moving cell");
{
  const target = Num(0);
  const sig = Num(0);
  const g = attract(sig, target, 5);  // attract with reactive target
  // Animate target while spring chases
  g.next();
  for (let i = 0; i < 100; i++) {
    target(i * 1.0);   // move target by 1 unit
    g.next(0.05);      // 0.05s frame
  }
  // Final position should be CLOSE to the moving target's last value
  check("reactive target — sig follows moving target",
    Math.abs(sig() - target()) < 10,
    { sig: sig(), target: target() });
}

// ── Error: behavior on typeless cell ────────────────────────────────

section("error handling");
{
  // For bare cells, the type is undefined — should throw.
  let caught: Error | null = null;
  try {
    const c: any = { peek: () => 0, type: undefined };  // fake typeless cell
    spring(c, 1, {});  // immediately fails on linearOf()
  } catch (e) {
    caught = e as Error;
  }
  check("behavior on typeless cell throws", caught !== null);
  check("error mentions linear/typeless",
    caught !== null && /typeless|linear/i.test(caught.message),
    caught?.message);
}

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${passed} passed   ${failed} failed`);
if (failed > 0) process.exit(1);
