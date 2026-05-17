import {
  circle,
  rect,
  group,
  num,
  vec,
  cell,
  Anim,
  Vec,
  Num,
  bounceIn,
  fadeUp,
  type Animator,
} from "./index";

const anim = new Anim();

// Compile-time assertion utilities.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function assert<_T extends true>(): void {}

function* run(): Animator {
  // ── Case 1: default — opacity is writable Cell<number>. ────────────
  const c1 = circle(vec(0, 0), 5);
  yield* c1.opacity.to(0, 1); // OK
  c1.opacity.value = 0.5; // OK
  yield* c1.translate.to({ x: 10, y: 0 }, 1); // OK

  // ── Case 2: literal value — still writable. ──────────────────────────
  const c2 = circle(vec(0, 0), 5, { opacity: 0.5 });
  yield* c2.opacity.to(1, 1); // OK

  // ── Case 3: caller-owned cell — writable. ──────────────────────────
  // Pass a `num(...)` (a Num.signal) so the resolved field is `Num.Writable`
  // and `.to(...)` is available. A plain `cell(0.5)` would be a
  // `Signal<number>` with no per-struct `[LERP]` slot.
  const o = num(0.5);
  const c3 = circle(vec(0, 0), 5, { opacity: o });
  yield* c3.opacity.to(1, 1); // OK
  c3.opacity.value = 0.2; // OK

  // ── Case 4: derived cell — readonly. Animation must be a TS error. ──────
  const c4 = circle(vec(0, 0), 5, { opacity: cell.derived(() => 0.5) });
  // @ts-expect-error — opacity is ReadonlyCell, has no `.to`.
  yield* c4.opacity.to(0, 1);
  // @ts-expect-error — `.value` is readonly on ReadonlyCell.
  c4.opacity.value = 0.2;
  // Reading is fine (subscribers / effects).
  const _read = c4.opacity.value;
  void _read;

  // ── Case 5: thunk — also readonly (sugar for derived). ─────────────
  const c5 = circle(vec(0, 0), 5, { opacity: () => 0.5 });
  // @ts-expect-error — thunk → ReadonlyCell.
  yield* c5.opacity.to(0, 1);

  // ── Case 6: Rect / Group / others propagate the same way. ───────────
  const r1 = rect(0, 0, 100, 50, {
    translate: cell.derived(() => ({ x: 0, y: 0 })),
  });
  // @ts-expect-error — translate is ReadonlyCell.
  yield* r1.translate.to({ x: 50, y: 0 }, 1);
  // But other animatable props are still fine.
  yield* r1.opacity.to(0.5, 1); // OK

  const g1 = group({ translate: cell.derived(() => ({ x: 0, y: 0 })) });
  // @ts-expect-error
  yield* g1.translate.to({ x: 0, y: 0 }, 1);
  // Other props still writable.
  yield* g1.scale.to({ x: 2, y: 2 }, 1); // OK
  yield* g1.opacity.to(0, 1); // OK

  // ── Case 7: structural transition helpers — only need the props they touch. ─
  const orbiter = group({ translate: cell.derived(() => ({ x: 0, y: 0 })) });
  // bounceIn only animates scale + opacity; orbiter has both writable. OK.
  yield* bounceIn(orbiter, 0.5);

  // fadeUp animates translate + opacity; orbiter's translate is readonly.
  // @ts-expect-error — translate is ReadonlyCell, doesn't satisfy WithTranslate.
  yield* fadeUp(orbiter, 0.5);
}

// Keep the function reachable so it gets typechecked.
anim.start(run);

// ── Pure type-level assertions ────────────────────────────────────────

// Default no-opts: every animatable prop is writable. Vec props
// resolve to `Vec.Writable` (writable lens-backed axes); scalar props to
// `Num.Writable` (writable Num — has `.to`).
{
  const c = circle(vec(0, 0), 5);
  assert<Equals<typeof c.opacity, Num.Writable>>();
  assert<Equals<typeof c.translate, Vec.Writable>>();
}

// Plain-value opts: still writable.
{
  const c = circle(vec(0, 0), 5, { opacity: 0.5 });
  assert<Equals<typeof c.opacity, Num.Writable>>();
}

// User Num.signal: writable.
{
  const o = num(0.5);
  const c = circle(vec(0, 0), 5, { opacity: o });
  assert<Equals<typeof c.opacity, Num.Writable>>();
}

// derived → Num.Readonly field.
{
  const c = circle(vec(0, 0), 5, { opacity: cell.derived(() => 0.5) });
  assert<Equals<typeof c.opacity, Num.Readonly>>();
}

// Thunk → Num.Readonly field.
{
  const c = circle(vec(0, 0), 5, { opacity: () => 0.5 });
  assert<Equals<typeof c.opacity, Num.Readonly>>();
}

// Mixed: one prop readonly, others default-writable.
{
  const g = group({ translate: cell.derived(() => ({ x: 0, y: 0 })) });
  assert<Equals<typeof g.translate, Vec.Readonly>>();
  assert<Equals<typeof g.opacity, Num.Writable>>();
  assert<Equals<typeof g.scale, Vec.Writable>>();
}

// ── Ergonomics: generic helpers over "any shape" ───────────────────────

// Pattern A: user writes `function f(s: Shape)` — with default O = ShapeOpts.
{
  function highlight(s: import("./shapes/shape").Shape) {
    s.opacity.value = 0.5;
    return s;
  }
  const c = circle(vec(0, 0), 5);
  highlight(c); // works — both resolve to writable Num-typed props.

  // But a shape with a readonly prop is NOT assignable here, by design.
  const g = group({ opacity: cell.derived(() => 0.5) });
  // @ts-expect-error — g.opacity is Num.Readonly, not Num.Writable (can't write).
  highlight(g);
}

// Pattern B: read-only access via AnyShape.
{
  function flashOnce(s: import("./shapes/shape").AnyShape) {
    return s.opacity.value;
  }
  flashOnce(circle(vec(0, 0), 5)); // OK
  flashOnce(group({ opacity: cell.derived(() => 0.5) })); // OK
}

// Pattern C: `Writable<K>` for "I touch these props".
{
  function pulse(s: import("./shapes/shape").Writable<"opacity">): Animator {
    return (function* () {
      yield* s.opacity.to(0.3, 0.5);
      yield* s.opacity.to(1, 0.5);
    })();
  }
  void pulse(circle(vec(0, 0), 5)); // OK
  void pulse(group({ translate: cell.derived(() => ({ x: 0, y: 0 })) })); // OK — only translate is readonly
  // @ts-expect-error — opacity is readonly here.
  void pulse(group({ opacity: cell.derived(() => 0.5) }));
}
