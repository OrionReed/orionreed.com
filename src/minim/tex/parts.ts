// Lightweight observable handles into a tex-rendered formula.
//
//      const { a, b, c } = parts("a", "b", "c");
//      tex`${a} + ${b} = ${c}`
//
// Identity for morph is by *marker reference*, not name. `PartMarker`
// composes a `Marker` (from `core/marker`) for the active/bind/register
// surface. All members of a group chain (`with`, `expand`) share the root's
// inner Marker, so any binding — prose hover, shape hover, animation — sets
// `active` for all of them simultaneously.
//
// Color is per-`PartMarker` and cascades up the `group` chain via
// `effectiveColor`, independently of the shared Marker. This lets you color
// a root marker and have the cascade reach all derived parts.
//
// `bindParts(eq, markers)` is the bridge between a TexShape and a set of
// Markers: it wires hover on each Part.el to the corresponding Marker and
// makes marker.active drive part.highlighted.
//
// The Boxlike surface on `Part` is installed at module load via
// `delegate(Part.prototype, "box", Box)` — see `signals/delegate.ts`.

import {
  effect,
  signal,
  type Signal,
  type ReadonlySignal,
} from "../core/signal";
import { cell, type Cell, type ReadonlyCell } from "../core/cell";
import { marker, hover, registerMarker, type Marker } from "../core/marker";
import { toSig, type Arg } from "../core/arg";
import { Box as BoxStruct, type Box, type Boxlike } from "../signals/box";
import type { WriteOf } from "../signals/struct";

type BoxCell = WriteOf<typeof BoxStruct>;
import { delegate } from "../signals/delegate";
import type { Pointlike } from "../signals/vec";
import type { TexShape } from "./tex";

export type { Marker } from "../core/marker";
export { getMarker } from "../core/marker";

/** A part's content can be a literal string, a signal, or a thunk. */
export type PartContent = Arg<string>;

/** Walk the `marker.group` chain to find the first marker with a
 *  non-null color. Setting `v.color` on a root marker tints `v` and
 *  every `v.expand({...})` child whose own color is null. */
const effectiveColor = (m: PartMarker): string | null => {
  for (let cur: PartMarker | null = m; cur; cur = cur.group) {
    const c = cur.color.value;
    if (c !== null) return c;
  }
  return null;
};

// ── Part ──────────────────────────────────────────────────────────────────────

/** A named, addressable region of a TexShape. Implements `Boxlike`
 *  so `part.center`, `part.top`, etc. are Pointlikes in the TexShape's
 *  local frame (read-only — parts are template-bound). */
export class Part<N extends string = string> implements Boxlike {
  /** Per-instance highlight for animations. Drives the background tint
   *  when set by `highlight()` or other animation code. Identity-level
   *  highlighting (from `Marker.active`) is wired externally via
   *  `bindParts()` which writes to this same signal. */
  readonly highlighted: Signal<boolean> = signal(false);
  /** Opacity in [0, 1]. Wired to `el.style.opacity`. */
  readonly opacity: Signal<number> = signal(1);

  readonly box: BoxCell;

  declare readonly x: ReadonlySignal<number>;
  declare readonly y: ReadonlySignal<number>;
  declare readonly w: ReadonlySignal<number>;
  declare readonly h: ReadonlySignal<number>;
  declare readonly center: Pointlike;
  declare readonly top: Pointlike;
  declare readonly bottom: Pointlike;
  declare readonly left: Pointlike;
  declare readonly right: Pointlike;
  declare readonly at: (u: number, v: number) => Pointlike;
  declare readonly area: ReadonlySignal<number>;

  el: HTMLElement | null = null;
  #disposers: Array<() => void> = [];

  constructor(
    readonly name: N,
    readonly content: ReadonlySignal<string>,
    box: BoxCell,
    readonly marker: PartMarker,
    readonly host: TexShape,
  ) {
    this.box = box;
  }

  /** @internal Wire reactive state to `el`'s inline styles. */
  bind(el: HTMLElement | null, highlightColor: string): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.el = el;
    if (!el) return;
    this.#disposers.push(
      effect(() => {
        if (this.highlighted.value) {
          // Use the marker's identity color if set, otherwise fall back
          // to the configured highlight token (e.g. from animation code
          // that calls highlight() directly, where no color is set).
          const color = effectiveColor(this.marker);
          el.style.backgroundColor = color
            ? `color-mix(in srgb, ${color} 15%, transparent)`
            : highlightColor;
        } else {
          el.style.backgroundColor = "transparent";
        }
      }),
      effect(() => {
        el.style.opacity = String(this.opacity.value);
      }),
      effect(() => {
        el.style.color = effectiveColor(this.marker) ?? "";
      }),
    );
  }

  /** @internal */
  dispose(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.el = null;
  }
}

delegate(Part.prototype, "box", BoxStruct, { exclude: ["box"] });

// ── PartMarker ────────────────────────────────────────────────────────────────

/** Marker emitted by `part(name, content)` and `parts({...})`. Only
 *  valid inside `tex\`…\`` template holes. Identity for morph is by
 *  marker reference; `group` threads parent-marker through derived
 *  markers so `v` and `v.expand({vx,vy,vz})` count as one identity
 *  (1↔3 morphs).
 *
 *  Composes a `Marker` (from `core/marker`) via a private `#m` field.
 *  All members of a group chain share the root's `#m` instance, so
 *  `active`/`bind`/`register` always refer to the root identity. Color
 *  is per-instance and cascades separately via the group chain. */
export class PartMarker<N extends string = string> {
  /** Per-instance color. `null` → walk up to parent via `effectiveColor`. */
  readonly color: Cell<string | null> = cell<string | null>(null);
  readonly content: ReadonlySignal<string>;

  /** Shared inner Marker. All members of a group chain share the root's
   *  instance, so bind/active/register all target the same identity. */
  #m: Marker;

  constructor(
    readonly name: N,
    source: PartContent,
    readonly group: PartMarker | null = null,
  ) {
    this.content = toSig(source) as ReadonlySignal<string>;
    // Children inherit the root's Marker so all group members share one identity.
    this.#m = group ? group.#m : marker();
  }

  /** Identity active signal — true when any rendering of this marker
   *  (prose, shape, animation) is currently active. */
  get active(): ReadonlyCell<boolean> {
    return this.#m.active;
  }

  /** Bind a local boolean signal to this marker's identity. Returns a disposer.
   *  See `Marker.bind` for full docs. */
  bind(local: Cell<boolean>): () => void {
    return this.#m.bind(local);
  }

  /** Register in the global lookup under `id`. Registers the PartMarker
   *  itself (not the inner Marker), so prose elements receive the full
   *  PartMarker interface including the group-chain color. */
  register(id: string): this {
    registerMarker(id, this);
    return this;
  }

  /** One-off content override, same identity. Child shares this marker's
   *  `#m`, so morph identity, color cascade, and active state are preserved. */
  with(content: PartContent): PartMarker<N> {
    return new PartMarker(this.name, content, this);
  }

  /** Expand into named child markers sharing this identity (1↔N morph).
   *
   *      const v = part("v", "\\vec{v}");
   *      const { vx, vy, vz } = v.expand({ vx: "v_x", vy: "v_y", vz: "v_z" });
   */
  expand<T extends Record<string, PartContent>>(
    spec: T,
  ): { readonly [K in keyof T & string]: PartMarker<K> } {
    const out: Record<string, PartMarker> = {};
    for (const k in spec) out[k] = new PartMarker(k, spec[k], this);
    return out as { readonly [K in keyof T & string]: PartMarker<K> };
  }
}

// ── Factories ─────────────────────────────────────────────────────────────────

export function part<N extends string>(
  name: N,
  content: PartContent = name,
): PartMarker<N> {
  return new PartMarker(name, content);
}

export function parts<T extends readonly (string | Record<string, PartContent>)[]>(
  ...specs: T
): MarkersFromSpecs<T> {
  const out: Record<string, PartMarker> = {};
  for (const spec of specs) {
    if (typeof spec === "string") {
      out[spec] = new PartMarker(spec, spec);
    } else {
      for (const k in spec) out[k] = new PartMarker(k, spec[k]);
    }
  }
  return out as MarkersFromSpecs<T>;
}

type MarkersFromSpecs<T extends readonly (string | Record<string, PartContent>)[]> = {
  readonly [K in NameOf<T[number]>]: PartMarker<K>;
};
type NameOf<S> = S extends string
  ? S
  : S extends Record<infer K, PartContent>
    ? K & string
    : never;

/** Set the same color on N markers at once. */
export function tint(
  color: string | null,
  ...markers: readonly { color: Cell<string | null> }[]
): void {
  for (const m of markers) m.color.value = color;
}

// ── Bridge ────────────────────────────────────────────────────────────────────

/** Wire hover on each named `Part.el` to the corresponding `Marker`, and
 *  make `marker.active` drive `part.highlighted`. Call in `scene()` and
 *  pass the result to `this.root.track()` for cleanup.
 *
 *      const [m, v] = palette(2);
 *      m.register("post:m"); v.register("post:v");
 *      const eq = s(tex`${part("m")}${part("v")}`);
 *      this.root.track(bindParts(eq, { m, v }));
 *
 *  `markers` is keyed by part name. Unrecognised keys and parts with no
 *  matching marker are silently skipped. */
export function bindParts(
  eq: { parts: Iterable<Part<string>> },
  markers: Partial<Record<string, Marker>>,
): () => void {
  const ds: Array<() => void> = [];
  for (const p of eq.parts) {
    const m = markers[p.name];
    if (!m || !p.el) continue;
    ds.push(hover(p.el, m));
    ds.push(effect(() => { p.highlighted.value = m.active.value; }));
  }
  return () => { for (const d of ds) d(); };
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type PartList<Names extends string = string> = readonly Part[] & {
  readonly [K in Names]: Part<K>;
};

// Silence unused-import warning.
void (null as unknown as Box);
