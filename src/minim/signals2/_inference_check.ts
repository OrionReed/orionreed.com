// Isolated type-level check for the composite-capability inference
// strategy. If this file compiles clean, the recursive `EffectivelyHas`
// predicate is safe to land in cell.ts.

interface VecCfg {
  defaults: { x: number; y: number };
  algebra: { add: (a: any, b: any) => any; sub: (a: any, b: any) => any; scale: (a: any, k: number) => any };
  lerp: (a: any, b: any, t: number) => any;
  metric: (a: any, b: any) => number;
}

interface NumCfg {
  defaults: number;
  algebra: { add: (a: number, b: number) => number; sub: (a: number, b: number) => number; scale: (a: number, k: number) => number };
  lerp: (a: number, b: number, t: number) => number;
  metric: (a: number, b: number) => number;
}

interface TransformCfg {
  defaults: {
    translate: { x: number; y: number };
    rotate: number;
    scale: { x: number; y: number };
    origin: { x: number; y: number };
    opacity: number;
  };
  nested: {
    translate: VecCfg;
    scale: VecCfg;
    origin: VecCfg;
    rotate: NumCfg;
    opacity: NumCfg;
  };
}

// Hypothetical deeper nesting — for depth checks.
interface SceneCfg {
  defaults: {
    transform: TransformCfg["defaults"];
    color: { r: number; g: number; b: number };
  };
  nested: {
    transform: TransformCfg;     // depth 2 already from here
    color: { defaults: { r: number; g: number; b: number }; algebra: { add: any; sub: any; scale: any } };
  };
}

// ── The predicate. Mirrors what we'd put in cell.ts. ───────────────

type EffectivelyHas<K extends string, C> =
  C extends { [P in K]: any }
    ? true
    : C extends { nested: infer N }
      ? AllChildrenHave<K, N>
      : false;

type AllChildrenHave<K extends string, N> =
  keyof N extends never
    ? false
    : { [F in keyof N]: EffectivelyHas<K, N[F]> }[keyof N] extends true
      ? true
      : false;

// ── Type-level assertions: these should all evaluate to `true`. ────

type Assert<T extends true> = T;

// Vec — direct algebra
type _v_algebra = Assert<EffectivelyHas<"algebra", VecCfg>>;
type _v_lerp    = Assert<EffectivelyHas<"lerp",    VecCfg>>;
type _v_metric  = Assert<EffectivelyHas<"metric",  VecCfg>>;

// Num — direct algebra
type _n_algebra = Assert<EffectivelyHas<"algebra", NumCfg>>;
type _n_lerp    = Assert<EffectivelyHas<"lerp",    NumCfg>>;

// Transform — algebra/lerp/metric composed through nested Vec+Num
type _tr_algebra = Assert<EffectivelyHas<"algebra", TransformCfg>>;
type _tr_lerp    = Assert<EffectivelyHas<"lerp",    TransformCfg>>;
type _tr_metric  = Assert<EffectivelyHas<"metric",  TransformCfg>>;

// Scene — depth 3 (Scene → Transform → Vec/Num)
type _sc_algebra = Assert<EffectivelyHas<"algebra", SceneCfg>>;

// Negative cases — should be `false` (so `Assert<false>` would FAIL).
// Verify each is structurally false:
type _v_has_unknown = EffectivelyHas<"frobnicate", VecCfg>;  // should be false
type _check_v_unknown = _v_has_unknown extends false ? true : never;
type _ = Assert<_check_v_unknown>;

// A type missing capabilities — has nested but children lack the cap
interface PartialNested {
  defaults: { a: number; b: number };
  nested: {
    a: { defaults: number; algebra: any };       // has algebra
    b: { defaults: number };                      // no algebra
  };
}
type _partial = EffectivelyHas<"algebra", PartialNested>;
type _partial_check = _partial extends false ? true : never;
type _ok2 = Assert<_partial_check>;

// Touch all to silence unused-locals.
type _all =
  | _v_algebra | _v_lerp | _v_metric
  | _n_algebra | _n_lerp
  | _tr_algebra | _tr_lerp | _tr_metric
  | _sc_algebra
  | _ | _ok2;

const _: _all = true;
void _;

console.log("type-level inference check compiled. EffectivelyHas safe.");
