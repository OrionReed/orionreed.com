// values_new.ts — value types migrated to the new class-based signals.ts.
//
// Differences vs values.ts (legacy):
//   - cell.value reads/writes (was: callable v() / v(x))
//   - cell.x.value for fields (was: callable v.x() / v.x(x))
//   - cell.add(b).value for methods (was: v.add(b)())
//   - Traits explicit in `traits: { linear, lerp, metric }`
//     (was: top-level config, with auto-synth for composites)
//   - `value` config key (was: `defaults`)
//   - `tag` config key (was: `name`)
//   - `getters` return plain values, auto-cached as own-prop
//     (was: returned derived RO cells, manual `derived(() => ...)`)

import { struct, type Cell, type Computed } from "./signals";

// ── Num ─────────────────────────────────────────────────────────────

export const Num = struct({
  tag: "Num",
  value: 0 as number,
  methods: {
    add: (a, b: number) => a + b,
    sub: (a, b: number) => a - b,
    scale: (a, k: number) => a * k,
    clamp: (a, lo: number, hi: number) => (a < lo ? lo : a > hi ? hi : a),
    abs: (a) => Math.abs(a),
  },
  traits: {
    linear: { add: (a, b) => a + b, sub: (a, b) => a - b, scale: (a, k) => a * k },
    lerp: (a, b, t) => a + (b - a) * t,
    metric: (a, b) => Math.abs(a - b),
  },
});

// ── Vec ─────────────────────────────────────────────────────────────

export interface V { x: number; y: number; }

const vAdd = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const vLerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export const Vec = struct({
  tag: "Vec",
  value: { x: 0, y: 0 } as V,
  methods: {
    add: vAdd, sub: vSub, scale: vScale, lerp: vLerp,
    perp: (a): V => ({ x: -a.y, y: a.x }),
    normalize: (a): V => {
      const len = Math.hypot(a.x, a.y) || 1;
      return { x: a.x / len, y: a.y / len };
    },
  },
  getters: {
    magnitude(this: Cell<V>) { return Math.hypot(this.value.x, this.value.y); },
  },
  traits: {
    linear: { add: vAdd, sub: vSub, scale: vScale },
    lerp: vLerp,
    metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  },
});

export const vec = (x: number, y: number) => Vec({ x, y });

// ── Color ───────────────────────────────────────────────────────────

export interface Color { r: number; g: number; b: number; a: number; }

const cAdd = (a: Color, b: Color): Color =>
  ({ r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, a: a.a + b.a });
const cSub = (a: Color, b: Color): Color =>
  ({ r: a.r - b.r, g: a.g - b.g, b: a.b - b.b, a: a.a - b.a });
const cScale = (a: Color, k: number): Color =>
  ({ r: a.r * k, g: a.g * k, b: a.b * k, a: a.a * k });
const cLerp = (a: Color, b: Color, t: number): Color => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
  a: a.a + (b.a - a.a) * t,
});

export const Color = struct({
  tag: "Color",
  value: { r: 0, g: 0, b: 0, a: 1 } as Color,
  methods: {
    add: cAdd, sub: cSub, scale: cScale, lerp: cLerp,
    blend: (a, b: Color, t: number): Color => ({
      r: a.r * (1 - t) + b.r * t,
      g: a.g * (1 - t) + b.g * t,
      b: a.b * (1 - t) + b.b * t,
      a: Math.max(a.a, b.a),
    }),
    withAlpha: (c, alpha: number): Color => ({ r: c.r, g: c.g, b: c.b, a: alpha }),
    lighten: (c, amount: number): Color => ({
      r: Math.min(1, c.r + amount),
      g: Math.min(1, c.g + amount),
      b: Math.min(1, c.b + amount),
      a: c.a,
    }),
  },
  getters: {
    luminance(this: Cell<Color>) {
      const c = this.value;
      return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    },
    css(this: Cell<Color>) {
      const c = this.value;
      return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
    },
  },
  traits: {
    linear: { add: cAdd, sub: cSub, scale: cScale },
    lerp: cLerp,
  },
});

export const rgb = (r: number, g: number, b: number) => Color({ r, g, b, a: 1 });
export const rgba = (r: number, g: number, b: number, a: number) => Color({ r, g, b, a });

// ── Transform ──────────────────────────────────────────────────────
//
// Composite typed struct. Each field is a sub-type (Vec/Num),
// materialized lazily as a Lens with the typed proto's methods/sub-fields.

export interface Tr {
  translate: V; scale: V; origin: V; rotate: number; opacity: number;
}

const trAdd = (a: Tr, b: Tr): Tr => ({
  translate: vAdd(a.translate, b.translate),
  scale: vAdd(a.scale, b.scale),
  origin: vAdd(a.origin, b.origin),
  rotate: a.rotate + b.rotate,
  opacity: a.opacity + b.opacity,
});
const trSub = (a: Tr, b: Tr): Tr => ({
  translate: vSub(a.translate, b.translate),
  scale: vSub(a.scale, b.scale),
  origin: vSub(a.origin, b.origin),
  rotate: a.rotate - b.rotate,
  opacity: a.opacity - b.opacity,
});
const trScale = (a: Tr, k: number): Tr => ({
  translate: vScale(a.translate, k),
  scale: vScale(a.scale, k),
  origin: vScale(a.origin, k),
  rotate: a.rotate * k,
  opacity: a.opacity * k,
});
const trLerp = (a: Tr, b: Tr, t: number): Tr => ({
  translate: vLerp(a.translate, b.translate, t),
  scale: vLerp(a.scale, b.scale, t),
  origin: vLerp(a.origin, b.origin, t),
  rotate: a.rotate + (b.rotate - a.rotate) * t,
  opacity: a.opacity + (b.opacity - a.opacity) * t,
});

export const Transform = struct({
  tag: "Transform",
  value: {
    translate: Vec,
    scale: Vec.with({ x: 1, y: 1 }),
    origin: Vec,
    rotate: 0,
    opacity: 1,
  },
  methods: {
    // `scale` is a field; method name is `scaleBy` to avoid collision.
    add: trAdd, sub: trSub, scaleBy: trScale, lerp: trLerp,
  },
  traits: {
    linear: { add: trAdd, sub: trSub, scale: trScale },
    lerp: trLerp,
  },
});

// ── Generic ops (mean, lerp, distance) ─────────────────────────────
//
// Generic over any T with the appropriate trait. Dispatch via
// `typeOf(cell).traits.X`. Returns Computed<T> not callable cells.

import { typeOf, computed, batch, type RO } from "./signals";

function linearOf<T>(c: Cell<T, any>) {
  const t: any = typeOf(c);
  if (!t?.traits?.linear) throw new Error(`type \`${t?.tag ?? "?"}\` has no linear trait`);
  return t.traits.linear;
}

function lerpOf<T>(c: Cell<T, any>) {
  const t: any = typeOf(c);
  if (!t?.traits?.lerp) throw new Error(`type \`${t?.tag ?? "?"}\` has no lerp trait`);
  return t.traits.lerp as (a: T, b: T, t: number) => T;
}

function metricOf<T>(c: Cell<T, any>) {
  const t: any = typeOf(c);
  if (!t?.traits?.metric) throw new Error(`type \`${t?.tag ?? "?"}\` has no metric trait`);
  return t.traits.metric as (a: T, b: T) => number;
}

/** Reactive arithmetic mean of N cells. Reads = avg; can also be
 *  written to distribute the delta across inputs. */
export function mean<T>(...cells: Cell<T, any>[]): Computed<T> & { write(target: T): void } {
  if (cells.length === 0) throw new Error("mean: need at least one cell");
  const lin = linearOf(cells[0]);
  const n = cells.length;
  const invN = 1 / n;
  const avg = computed(() => {
    let acc = cells[0].value;
    for (let i = 1; i < n; i++) acc = lin.add(acc, cells[i].value);
    return lin.scale(acc, invN);
  });
  (avg as any).write = (target: T) => {
    let curAvg = cells[0].peek();
    for (let i = 1; i < n; i++) curAvg = lin.add(curAvg, cells[i].peek());
    curAvg = lin.scale(curAvg, invN);
    const delta = lin.sub(target, curAvg);
    batch(() => {
      for (let i = 0; i < n; i++) cells[i].value = lin.add(cells[i].peek(), delta);
    });
  };
  return avg as any;
}

export function lerp<T>(a: Cell<T, any>, b: Cell<T, any>, t: number | (() => number)): RO<T> {
  const fn = lerpOf(a);
  const tg = typeof t === "function" ? t : () => t;
  return computed(() => fn(a.value, b.value, tg()));
}

export function distance<T>(a: Cell<T, any>, b: Cell<T, any>): RO<number> {
  const fn = metricOf(a);
  return computed(() => fn(a.value, b.value));
}
