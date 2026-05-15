// Value-type runtime checks for Color, Box, Matrix2D — proves the new
// types work end-to-end through the signals2 cell + capability layer.
//
// Reuses the same generic ops (`mean`, `lerp`, `distance`) to confirm
// they dispatch correctly via `cell.type.*` for every value type.

import { mean, lerp, distance } from "./generics";
import {
  Num, Vec, vec, type V,
  Color, rgb, rgba,
  Box, box, expandBox, unionBox, isBox,
  Matrix2D, mat, identity, multiplyMatrix, invertMatrix,
  fromTranslate, fromScale, fromRotate, transformPoint, transformBox,
  Transform,
} from "./values";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ""}`); }
}
function section(s: string): void { console.log(`\n── ${s} ────────────────────────`); }

// ── Color ───────────────────────────────────────────────────────────

section("Color");
{
  const red = rgb(1, 0, 0);
  const green = rgb(0, 1, 0);

  check("Color cell reads as object", red().r === 1 && red().g === 0);
  check("Color.lerp halfway is yellow-ish",
    Math.abs(red.lerp(green, 0.5)().r - 0.5) < 1e-9);
  check("Color.add", red.add(green)().r === 1 && red.add(green)().g === 1);
  check("Color.withAlpha as method", red.withAlpha(0.5)().a === 0.5);
  check("Color.lighten as method", red.lighten(0.2)().r === 1);

  // getters (lazy, cached)
  check("luminance getter", Math.abs(red.luminance() - 0.299) < 1e-9);
  check("css getter", red.css() === "rgba(255,0,0,1)");

  // Generic op (mean) dispatching via Color's linear capability:
  const blue = rgb(0, 0, 1);
  const avg = mean(red, green, blue);
  check("mean<Color> averages correctly",
    Math.abs(avg().r - 1/3) < 1e-9 && Math.abs(avg().b - 1/3) < 1e-9);

  // Auto-synthesised equals
  const c1 = Color({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  const c2 = Color({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  check("Color.type.equals (auto-synthesised) recognises matching",
    Color.equals!(c1(), c2()) === true);
  check("Color.type.equals rejects different",
    Color.equals!(c1(), { r: 0.6, g: 0.5, b: 0.5, a: 1 }) === false);
}

// ── Matrix2D ────────────────────────────────────────────────────────

section("Matrix2D");
{
  const T = fromTranslate(10, 20);
  const S = fromScale(2, 2);
  const R = fromRotate(Math.PI / 2);

  check("identity()", identity().a === 1 && identity().b === 0);
  check("fromTranslate.e/f", T.e === 10 && T.f === 20);
  check("plain multiplyMatrix",
    multiplyMatrix(T, S).a === 2 && multiplyMatrix(T, S).e === 10);
  check("plain invertMatrix is true inverse",
    Math.abs(multiplyMatrix(T, invertMatrix(T)).e) < 1e-9);

  // transformPoint via plain helper
  const p = transformPoint(T, { x: 0, y: 0 });
  check("transformPoint translates", p.x === 10 && p.y === 20);

  // transformBox identity short-circuit
  const b: Box = { x: 0, y: 0, w: 100, h: 50 };
  check("transformBox(identity) is identity-on-box", transformBox(identity(), b) === b);

  // Reactive Matrix2D cell + chainable methods
  const m = mat(1, 0, 0, 1, 5, 5);
  check("Matrix2D cell read", m().e === 5 && m().f === 5);
  check("m.multiply(other) is a derived cell",
    m.multiply(fromTranslate(10, 10))().e === 15);
  // determinant is a lifted scalar method — call returns a Cell<number>,
  // call again to read the value (chain-of-calls is the standard pattern
  // for lifted methods in signals2).
  check("m.determinant()() reads the value",
    ((m.determinant as unknown as () => () => number)())() === 1);

  // No linear/lerp/metric — confirm:
  check("Matrix2D has no linear (matrix algebra isn't VS-over-ℝ)",
    Matrix2D.linear === undefined);
  check("Matrix2D has no lerp", Matrix2D.lerp === undefined);

  // rotation composition: rotate * rotate = rotate by sum
  const R2 = multiplyMatrix(R, R);
  check("rotate × rotate = 2× rotate",
    Math.abs(R2.a - Math.cos(Math.PI)) < 1e-9);
}

// ── Box ─────────────────────────────────────────────────────────────

section("Box");
{
  const b1 = Box({ x: 0, y: 0, w: 100, h: 50 });

  check("Box cell read", b1().w === 100 && b1().h === 50);

  // Capability methods via composed defaults? No — Box has direct
  // linear/lerp/metric (not composite from nested).
  check("Box.linear directly", typeof Box.linear === "object");
  check("Box.lerp directly", typeof Box.lerp === "function");
  check("Box.metric directly", typeof Box.metric === "function");

  // Plain-value helpers
  const e = expandBox(b1(), 10);
  check("expandBox", e.x === -10 && e.w === 120);
  check("unionBox of two", unionBox({x:0,y:0,w:10,h:10}, {x:5,y:5,w:10,h:10}).w === 15);

  // Custom methods
  check("Box.at returns derived V", b1.at(0.5, 0.5)().x === 50);
  check("Box.expand as method", b1.expand(5)().w === 110);
  check("Box.contains", b1.contains({x: 50, y: 25}) as unknown as boolean);

  // Lazy getters (cached)
  const c = b1.center;
  check("center is a derived V cell", c().x === 50 && c().y === 25);
  check("center is cached (same identity)", b1.center === c);
  check("top, bottom, left, right",
    b1.top().y === 0 && b1.bottom().y === 50 &&
    b1.left().x === 0 && b1.right().x === 100);
  check("area = w*h", (b1.area as unknown as () => number)() === 5000);

  // Self-reference for BoxLike compatibility
  check("box.box === box (BoxLike self-ref)", b1.box === b1);
  check("isBox(reactive Box) is true", isBox(b1));
  check("isBox(plain object) is false", !isBox({ x: 0, y: 0, w: 1, h: 1 }));

  // Generic ops over Box
  const b2 = Box({ x: 100, y: 100, w: 50, h: 50 });
  const lerpedB = lerp(b1, b2, 0.5);
  check("lerp(Box, Box) via generics",
    lerpedB().x === 50 && lerpedB().w === 75);
  check("distance(Box, Box) via generics",
    distance(b1, b2)() > 0);
}

// ── Transform with Color in fields (cross-type composition) ─────────

section("Cross-type composition");
{
  // A hypothetical "styled transform" with Color baked in — exercises
  // composite-capability lifting through unrelated types.
  interface Styled {
    pose: { translate: V; rotate: number; scale: V; origin: V; opacity: number };
    fill: Color;
  }

  // Note: the linear-composition would require both Tr and Color to
  // have linear. They do. So mean over Styled would work IF declared.
  // We don't need to formally declare Styled — just verify Transform
  // works.
  const tr1 = Transform({
    translate: { x: 0, y: 0 }, rotate: 0,
    scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 1,
  });
  const tr2 = Transform({
    translate: { x: 100, y: 100 }, rotate: Math.PI,
    scale: { x: 2, y: 2 }, origin: { x: 0, y: 0 }, opacity: 0,
  });

  // Generic ops dispatch
  const midTr = lerp(tr1, tr2, 0.5);
  check("lerp(Transform, Transform, 0.5)",
    midTr().translate.x === 50 && Math.abs(midTr().rotate - Math.PI / 2) < 1e-9);
  check("distance(Transform, Transform) — composite metric",
    distance(tr1, tr2)() > 0);
}

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${passed} passed   ${failed} failed`);
if (failed > 0) process.exit(1);
