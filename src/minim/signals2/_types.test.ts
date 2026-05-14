// Type-level inference sanity. These should ALL compile clean.
// If any line goes red, the inference is broken.
//
// Run via tsc; runtime behavior already tested elsewhere.

import { struct, type Cell, type RO } from "./cell";
import { Vec, Num, Transform, type Tr } from "./values";

// ── Cell surfaces inferred from struct({...}) literal ──────────────

const v = Vec({ x: 1, y: 2 });

// Reading: `v()` returns the plain shape.
const _vRead: { x: number; y: number } = v();
// Peek: same shape, untracked.
const _vPeek: { x: number; y: number } = v.peek();

// Writing: `v(value)` is void.
const _vWrite: void = v({ x: 3, y: 4 });

// Axes inferred from `defaults` keys.
const _vx: Cell<number> = v.x;
const _vy: Cell<number> = v.y;

// Methods inferred from `methods: { perp, normalize }`.
// These should be present on the Cell.
const _perp: RO<{ x: number; y: number }> = v.perp();
const _norm: RO<{ x: number; y: number }> = v.normalize();

// Algebra-derived methods.
const _add: RO<{ x: number; y: number }> = v.add({ x: 1, y: 1 });
const _sub: RO<{ x: number; y: number }> = v.sub({ x: 1, y: 1 });
const _scale: RO<{ x: number; y: number }> = v.scale(2);

// Lerp / distance.
const _lerp: RO<{ x: number; y: number }> = v.lerp({ x: 10, y: 0 }, 0.5);
const _dist: RO<number> = v.distance({ x: 0, y: 0 });

// Lazy getter from `getters: { magnitude }`. The getter's return type
// is preserved literally — `magnitude` returns whatever `computed(...)`
// returns, which is the engine's `SignalFn<number>`. This is a Cell-
// shape (callable + .peek added via our base proto), not strictly
// RO<number>, because the user code didn't run it through the cell
// factory. Use `Vec.derived(...)` inside the getter if you want RO<T>.
const _mag = v.magnitude;
const _magCalled: number = _mag();

// Plain math on the type.
const _addPlain: { x: number; y: number } = Vec.add!({ x: 1, y: 2 }, { x: 3, y: 4 });
const _lerpPlain: { x: number; y: number } = Vec.lerp!({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5);
const _metricPlain: number = Vec.metric!({ x: 0, y: 0 }, { x: 3, y: 4 });

// ── Num ─────────────────────────────────────────────────────────────

const n = Num(5);
const _nRead: number = n();
const _nClamp: RO<number> = n.clamp(0, 10);
const _nAbs: RO<number> = n.abs();
const _nAdd: RO<number> = n.add(10);

// ── Transform — capabilities composed THROUGH NESTED, surface inferred

const tr = Transform({
  translate: { x: 0, y: 0 }, rotate: 0,
  scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 1,
});
const _trRead = tr();
// Composite-capability inference: Transform declares NO linear/lerp/
// metric, but `EffectivelyHas<"linear", typeof Transform.config>`
// recurses through `nested: { translate: Vec, ... }` and resolves true
// because all children have it. The surface mixins fire — `tr.lerp`,
// `tr.add`, `tr.distance` are all directly typed.
const _trLerp: RO<Tr> = tr.lerp(_trRead, 0.5);
const _trAdd: RO<Tr>  = tr.add(_trRead);
const _trSub: RO<Tr>  = tr.sub(_trRead);
const _trScale: RO<Tr> = tr.scale(2);
const _trDist: RO<number> = tr.distance(_trRead);
void _trLerp; void _trAdd; void _trSub; void _trScale; void _trDist;

// ── Inline new type — full inference, no manual annotations ────────

const Angle = struct({
  name: "Angle",
  defaults: { rad: 0 } as { rad: number },
  lerp: (a, b, t) => ({ rad: a.rad + (b.rad - a.rad) * t }),
  linear: {
    add: (a, b) => ({ rad: a.rad + b.rad }),
    sub: (a, b) => ({ rad: a.rad - b.rad }),
    scale: (a, k) => ({ rad: a.rad * k }),
  },
  metric: (a, b) => Math.abs(a.rad - b.rad),
  methods: {
    deg: (a) => a.rad * 180 / Math.PI,
  },
});
const aCell = Angle({ rad: Math.PI });
const _aRead = aCell();
const _aLerp = aCell.lerp({ rad: 0 }, 0.5);
const _aAdd = aCell.add({ rad: 1 });
const _aDist: RO<number> = aCell.distance({ rad: 0 });
const _aDeg = aCell.deg();    // user method via methods bag
const _aRad: Cell<number> = aCell.rad;  // axis from defaults key

// ── Negative tests — these SHOULD fail at compile time. ─────────────
// Uncomment to verify rejection.

// const _bareCell: number = v.x;  // ← would fail: v.x is Cell<number>, not number
// const _wrongMethod = v.nonexistent();  // ← would fail: not in methods

console.log("type-level inference test compiled. All inference paths green.");

// Touch all bindings so unused-locals stays quiet.
void _vRead; void _vPeek; void _vWrite;
void _vx; void _vy;
void _perp; void _norm;
void _add; void _sub; void _scale;
void _lerp; void _dist; void _mag; void _magCalled;
void _addPlain; void _lerpPlain; void _metricPlain;
void _nRead; void _nClamp; void _nAbs; void _nAdd;
void _trRead;
void _aRead; void _aLerp; void _aAdd; void _aDist; void _aDeg; void _aRad;
