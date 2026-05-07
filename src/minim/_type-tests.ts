import {
  circle,
  rect,
  group,
  pt,
  signal,
  computed,
  Anim,
  Signal,
  type Animator,
  type ReadonlySignal,
} from "./index";
import { bounceIn, fadeUp } from "./motion";

const anim = new Anim();

// Compile-time assertion utilities.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function assert<_T extends true>(): void {}

function* run(): Animator {
  // ── Case 1: default — opacity is writable Signal<number>. ────────────
  const c1 = circle(pt(0, 0), 5);
  yield* c1.opacity.to(0, 1); // OK
  c1.opacity.value = 0.5; // OK
  yield* c1.translate.to({ x: 10, y: 0 }, 1); // OK

  // ── Case 2: literal value — still writable. ──────────────────────────
  const c2 = circle(pt(0, 0), 5, { opacity: 0.5 });
  yield* c2.opacity.to(1, 1); // OK

  // ── Case 3: caller-owned Signal — writable. ──────────────────────────
  const o = signal(0.5);
  const c3 = circle(pt(0, 0), 5, { opacity: o });
  yield* c3.opacity.to(1, 1); // OK
  c3.opacity.value = 0.2; // OK

  // ── Case 4: computed — readonly. Animation must be a TS error. ──────
  const c4 = circle(pt(0, 0), 5, { opacity: computed(() => 0.5) });
  // @ts-expect-error — opacity is ReadonlySignal, has no `.to`.
  yield* c4.opacity.to(0, 1);
  // @ts-expect-error — `.value` is readonly on ReadonlySignal.
  c4.opacity.value = 0.2;
  // Reading is fine (subscribers / effects).
  const _read = c4.opacity.value;
  void _read;

  // ── Case 5: thunk — also readonly (sugar for computed). ─────────────
  const c5 = circle(pt(0, 0), 5, { opacity: () => 0.5 });
  // @ts-expect-error — thunk → ReadonlySignal.
  yield* c5.opacity.to(0, 1);

  // ── Case 6: Rect / Group / others propagate the same way. ───────────
  const r1 = rect(0, 0, 100, 50, {
    translate: computed(() => ({ x: 0, y: 0 })),
  });
  // @ts-expect-error — translate is ReadonlySignal.
  yield* r1.translate.to({ x: 50, y: 0 }, 1);
  // But other animatable props are still fine.
  yield* r1.opacity.to(0.5, 1); // OK

  const g1 = group({ translate: computed(() => ({ x: 0, y: 0 })) });
  // @ts-expect-error
  yield* g1.translate.to({ x: 0, y: 0 }, 1);
  // Other props still writable.
  yield* g1.scale.to({ x: 2, y: 2 }, 1); // OK
  yield* g1.opacity.to(0, 1); // OK

  // ── Case 7: structural transition helpers — only need the props they touch. ─
  const orbiter = group({ translate: computed(() => ({ x: 0, y: 0 })) });
  // bounceIn only animates scale + opacity; orbiter has both writable. OK.
  yield* bounceIn(orbiter, 0.5);

  // fadeUp animates translate + opacity; orbiter's translate is readonly.
  // @ts-expect-error — translate is ReadonlySignal, doesn't satisfy WithTranslate.
  yield* fadeUp(orbiter, 0.5);
}

// Keep the function reachable so it gets typechecked.
anim.run(run);

// ── Pure type-level assertions ────────────────────────────────────────

// Default no-opts: every animatable prop is a writable Signal.
{
  const c = circle(pt(0, 0), 5);
  assert<Equals<typeof c.opacity, Signal<number>>>();
  assert<Equals<typeof c.translate, Signal<{ x: number; y: number }>>>();
}

// Plain-value opts: still writable.
{
  const c = circle(pt(0, 0), 5, { opacity: 0.5 });
  assert<Equals<typeof c.opacity, Signal<number>>>();
}

// User Signal: writable.
{
  const o = signal(0.5);
  const c = circle(pt(0, 0), 5, { opacity: o });
  assert<Equals<typeof c.opacity, Signal<number>>>();
}

// computed → ReadonlySignal field.
{
  const c = circle(pt(0, 0), 5, { opacity: computed(() => 0.5) });
  assert<Equals<typeof c.opacity, ReadonlySignal<number>>>();
}

// Thunk → ReadonlySignal field.
{
  const c = circle(pt(0, 0), 5, { opacity: () => 0.5 });
  assert<Equals<typeof c.opacity, ReadonlySignal<number>>>();
}

// Mixed: one prop readonly, others default-writable.
{
  const g = group({ translate: computed(() => ({ x: 0, y: 0 })) });
  assert<
    Equals<typeof g.translate, ReadonlySignal<{ x: number; y: number }>>
  >();
  assert<Equals<typeof g.opacity, Signal<number>>>();
  assert<Equals<typeof g.scale, Signal<{ x: number; y: number }>>>();
}

// ── Ergonomics: generic helpers over "any shape" ───────────────────────

// Pattern A: user writes `function f(s: Shape)` — with default O = ShapeOpts.
// Default-typed shapes (created without the conditional-narrowing kicking
// in) should be assignable. circle(p, r) returns Circle<{}>, so this is
// the litmus test for "is the empty-opts case structurally compatible
// with the default-opts case?".
{
  function highlight(s: import("./scene/shape").Shape) {
    s.opacity.value = 0.5;
    return s;
  }
  const c = circle(pt(0, 0), 5);
  highlight(c); // works — both resolve to Signal-typed props.

  // But a shape with a readonly prop is NOT assignable here, by design.
  const g = group({ opacity: computed(() => 0.5) });
  // @ts-expect-error — g.opacity is ReadonlySignal, not Signal.
  highlight(g);
}

// Pattern B: user wants to accept any shape and read (not write).
// Use AnyShape — IsAny widens prop types to the union, so reads work
// uniformly without narrowing.
{
  function flashOnce(s: import("./scene/shape").AnyShape) {
    return s.opacity.value;
  }
  flashOnce(circle(pt(0, 0), 5)); // OK
  flashOnce(group({ opacity: computed(() => 0.5) })); // OK
}

// Pattern C: user wants to accept any shape AND animate. Use the
// `Writable<K>` utility — only the props the helper touches must be
// writable. Combinable via union of keys.
{
  function pulse(s: import("./scene/shape").Writable<"opacity">): Animator {
    return (function* () {
      yield* s.opacity.to(0.3, 0.5);
      yield* s.opacity.to(1, 0.5);
    })();
  }
  void pulse(circle(pt(0, 0), 5)); // OK
  void pulse(group({ translate: computed(() => ({ x: 0, y: 0 })) })); // OK — only translate is readonly
  // @ts-expect-error — opacity is readonly here.
  void pulse(group({ opacity: computed(() => 0.5) }));
}
