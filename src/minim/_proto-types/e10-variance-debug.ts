export {};

// E10 — Isolate the variance issue. Why does `function(s: Signal<T, RW>)`
// accept a `Signal<T, RO>` when `const x: Signal<T, RW> = ro` correctly
// rejects?

interface RO { readonly __sig: true }
interface RW extends RO { readonly __rw: true }

declare class S<T, out C extends RO = RO> {
  get value(): T;
  set value(v: C extends RW ? T : never);
  peek(): T;
}

declare const ro: S<number, RO>;
declare const rw: S<number, RW>;

// ── DIRECT ASSIGNMENT — works (e7 confirmed this) ──────────────────
const _assign1: S<number, RW> = rw;  // OK
// @ts-expect-error — should fail
const _assign2: S<number, RW> = ro;

// ── FUNCTION CALL — does it also reject? ───────────────────────────
function needsRW(s: S<number, RW>): void {
  s.value = 5;
}
needsRW(rw);  // OK
// @ts-expect-error — should fail
needsRW(ro);

// ── METHOD ARG (BIVARIANT) — does it leak? ─────────────────────────
declare class Wrapper {
  // method syntax — bivariant under strictFunctionTypes
  needsRWMethod(s: S<number, RW>): void;
}
declare const w: Wrapper;
w.needsRWMethod(rw);
// @ts-expect-error
w.needsRWMethod(ro);

// ── INTERSECTION CONSTRAINT — what e9's spring did ─────────────────
// Constraint that mirrors `Signal<T, RW> & Traits<T, K>`.
type TraitMarker<T> = {
  readonly constructor: { readonly someField: T };  // simulated trait constraint
};

declare function springish<T>(s: S<T, RW> & TraitMarker<T>, target: T): void;

declare class Vec2<out C extends RO = RO> extends S<{ x: number; y: number }, C> {}
// Vec2 needs the merged constructor:
interface Vec2 {
  readonly constructor: { readonly someField: { x: number; y: number } };
}

declare const v2: Vec2<RW>;
declare const v2ro: Vec2<RO>;

springish(v2, { x: 0, y: 0 });        // OK

// THESE SHOULD FAIL — they don't. Investigating why.
springish(v2ro, { x: 0, y: 0 });
springish<{ x: number; y: number }>(v2ro, { x: 0, y: 0 });

// ─── Workaround attempts ───────────────────────────────────────────

// Attempt 1: split into two generic parameters
declare function springSplit<T, R extends S<T, RW> & TraitMarker<T>>(s: R, target: T): void;
springSplit(v2, { x: 0, y: 0 });
// @ts-expect-error — does this work?
springSplit(v2ro, { x: 0, y: 0 });

// Attempt 2: constrain via R, infer T from R
declare function springR<R extends S<unknown, RW>>(
  s: R & TraitMarker<R extends S<infer T, RO> ? T : never>,
  target: R extends S<infer T, RO> ? T : never,
): void;
springR(v2, { x: 0, y: 0 });
// @ts-expect-error
springR(v2ro, { x: 0, y: 0 });

// Attempt 3: separate function arg for the trait constraint
declare function springSep<T>(s: S<T, RW>, target: T, _: TraitMarker<T> | undefined): void;
springSep(v2, { x: 0, y: 0 }, v2);
// @ts-expect-error
springSep(v2ro, { x: 0, y: 0 }, v2ro);

// Attempt 4: trait marker NOT on `constructor` (try a unique-symbol key)
declare const __traitMarker: unique symbol;
type TraitMarker2<T> = { readonly [__traitMarker]: T };

declare function springAlt<T>(s: S<T, RW> & TraitMarker2<T>, target: T): void;

declare const v3: Vec2<RW> & TraitMarker2<{ x: number; y: number }>;
declare const v3ro: Vec2<RO> & TraitMarker2<{ x: number; y: number }>;

springAlt(v3, { x: 0, y: 0 });
// @ts-expect-error — does symbol-keyed brand fix it?
springAlt(v3ro, { x: 0, y: 0 });
