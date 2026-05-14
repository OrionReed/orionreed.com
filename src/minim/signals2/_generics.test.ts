// Demonstrate that generic capability-driven ops (`mean<T>`, `lerp<T>`,
// `distance<T>`, `springStep<T>`) work uniformly over any value type
// with the right capabilities — Num, Vec, Transform, and a custom
// type defined inline. No `[ALGEBRA]`/`[LERP]`/`[METRIC]` symbols
// needed; dispatch goes via `cell.type.linear` etc.

import { mean, lerp, distance, springStep, serialise } from "./generics";
import { Num, Vec, Transform } from "./values";
import { struct, type Cell } from "./cell";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} ${extra !== undefined ? JSON.stringify(extra) : ""}`); }
}
function section(s: string) { console.log(`\n── ${s} ────────────────────────────────`); }

// ── mean works for numbers ──────────────────────────────────────────

section("mean<number> (via Num's linear)");
{
  const a = Num(0);
  const b = Num(10);
  const c = Num(20);
  const m = mean(a, b, c);
  check("initial mean", m() === 10);
  m(13);
  check("a after distribute", a() === 3);
  check("b after distribute", b() === 13);
  check("c after distribute", c() === 23);
  check("mean now", m() === 13);
}

// ── mean works for Vecs — SAME generic function, different type ────

section("mean<Vec> (via Vec's linear — same generic mean function)");
{
  const a = Vec({ x: 0, y: 0 });
  const b = Vec({ x: 100, y: 50 });
  const m = mean(a, b);
  check("initial centroid", m().x === 50 && m().y === 25);
  m({ x: 60, y: 35 });
  check("a after distribute (shifted by 10,10)", a().x === 10 && a().y === 10);
  check("b after distribute", b().x === 110 && b().y === 60);
}

// ── lerp works for Vec via dispatch ─────────────────────────────────

section("lerp<Vec>");
{
  const a = Vec({ x: 0, y: 0 });
  const b = Vec({ x: 10, y: 20 });
  const mid = lerp(a, b, 0.5);
  check("midpoint", mid().x === 5 && mid().y === 10);
  a({ x: 100, y: 100 });
  check("reactive midpoint after a moves", mid().x === 55 && mid().y === 60);
}

// ── lerp + distance for Transform — capabilities composed from nested ─

section("Transform capabilities (composed from nested Vec+Num)");
{
  const trA = Transform({
    translate: { x: 0, y: 0 }, rotate: 0,
    scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 0,
  });
  const trB = Transform({
    translate: { x: 100, y: 50 }, rotate: 1.5,
    scale: { x: 2, y: 2 }, origin: { x: 0, y: 0 }, opacity: 1,
  });
  const mid = lerp(trA, trB, 0.5);
  const v = mid();
  check("mid.translate.x = 50", v.translate.x === 50);
  check("mid.translate.y = 25", v.translate.y === 25);
  check("mid.rotate = 0.75", v.rotate === 0.75);
  check("mid.opacity = 0.5", v.opacity === 0.5);
  const d = distance(trA, trB);
  check("distance > 0 (euclidean composite)", d() > 0);
}

// ── springStep — generic over any linear+metric type ──────────────

section("springStep — Vec");
{
  const sig = Vec({ x: 0, y: 0 });
  const targetV = { x: 100, y: 0 };
  const vel = { current: { x: 0, y: 0 } };
  let settled = false;
  for (let i = 0; i < 500 && !settled; i++) {
    settled = springStep(
      sig as Cell<{ x: number; y: number }>,
      () => targetV,
      vel,
      0.016, // 60fps
      { stiffness: 100, damping: 10, precision: 0.01 },
    );
  }
  check("spring settled toward target", settled);
  check("final x near 100", Math.abs(sig().x - 100) < 1);
}

// ── User-defined capability — no `registerCapability` needed ───────

section("User-defined capability (`serialise`) — just stamp it");
{
  // Add a `serialise` capability to Num. No framework registration —
  // generic `serialise<T>()` reads `t.serialise` directly.
  (Num as any).serialise = (n: number) => `n:${n.toFixed(2)}`;
  const x = Num(3.14159);
  const s = serialise(x);
  check("serialise reads via cell.type.serialise", s() === "n:3.14");
  x(2.71828);
  check("reactive: updates on write", s() === "n:2.72");
}

// ── Inline new type with capabilities — no ceremony ───────────────

section("Inline new type works out of the box");
{
  // Define an Angle type — radians, with linear + lerp + metric.
  interface Angle { rad: number }
  const Angle = struct({
    name: "Angle",
    defaults: { rad: 0 } as Angle,
    lerp: (a, b, t) => ({ rad: a.rad + (b.rad - a.rad) * t }),
    linear: {
      add: (a, b) => ({ rad: a.rad + b.rad }),
      sub: (a, b) => ({ rad: a.rad - b.rad }),
      scale: (a, k) => ({ rad: a.rad * k }),
    },
    metric: (a, b) => Math.abs(a.rad - b.rad),
  });
  const a1 = Angle({ rad: 0 });
  const a2 = Angle({ rad: Math.PI });
  const half = lerp(a1, a2, 0.5);
  check("inline Angle works with generic lerp", Math.abs(half().rad - Math.PI / 2) < 1e-9);

  const a3 = Angle({ rad: 1 });
  const m = mean(a1 as any, a3 as any) as any;
  check("inline Angle works with generic mean", Math.abs(m().rad - 0.5) < 1e-9);
}

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${passed} passed   ${failed} failed`);
if (failed > 0) process.exit(1);
