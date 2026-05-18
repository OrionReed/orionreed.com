// Observable handles into a tex-rendered formula. Identity for morph
// is by marker reference; `with`/`expand` share the root's identity.
// Color cascades up the `group` chain via `effectiveColor`.

import {
  signal, computed, effect,
  Signal, num, Box,
  type Val,
} from "@minim/signals";
import {marker, hover, highlightTint, registerMarker, type Marker} from "./marker";
import type {TexShape} from "./tex";

export type { Marker };

export type PartContent = Val<string>;

/** Walk the `marker.group` chain to first non-null color. */
const effectiveColor = (m: PartMarker): string | null => {
  for (let cur: PartMarker | null = m; cur; cur = cur.group) {
    const c = cur.color.value;
    if (c !== null) return c;
  }
  return null;
};

/** Named, addressable region of a TexShape (read-only, template-bound).
 *  Reach into `part.box` for axes/cardinals. */
export class Part<N extends string = string> {
  /** Background-tint highlight; written by `highlight()` and `bindParts()`. */
  readonly highlighted: Signal<boolean> = signal(false);
  readonly opacity = num(1);

  readonly box: Box;

  el: HTMLElement | null = null;
  #disposers: Array<() => void> = [];

  constructor(
    readonly name: N,
    readonly content: Signal<string>,
    box: Box,
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
          const color = effectiveColor(this.marker);
          el.style.backgroundColor = color ? highlightTint(color) : highlightColor;
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

/** Marker emitted by `part()` / `parts()`; valid inside `tex\`…\`` holes.
 *  Group members share one inner `Marker` so they share identity. */
export class PartMarker<N extends string = string> {
  /** Per-instance color; `null` walks up the group chain. */
  readonly color: Signal<string | null> = signal<string | null>(null);
  readonly content: Signal<string>;

  /** Shared inner Marker; all group members alias the root's instance. */
  #m: Marker;

  constructor(
    readonly name: N,
    source: PartContent,
    readonly group: PartMarker | null = null,
  ) {
    this.content = source instanceof Signal
      ? source
      : typeof source === "function"
        ? computed(source)
        : signal(source as string);
    this.#m = group ? group.#m : marker();
  }

  /** True when any rendering of this identity (prose/shape/anim) is active. */
  get active(): Signal<boolean> {
    return this.#m.active;
  }

  /** Bind a local boolean signal to this marker's identity. */
  bind(local: Signal<boolean>): () => void {
    return this.#m.bind(local);
  }

  /** Register in the global lookup under `id`. */
  register(id: string): this {
    registerMarker(id, this);
    return this;
  }

  /** One-off content override, same identity. */
  with(content: PartContent): PartMarker<N> {
    return new PartMarker(this.name, content, this);
  }

  /** Expand into named child markers sharing this identity (1↔N morph). */
  expand<T extends Record<string, PartContent>>(
    spec: T,
  ): { readonly [K in keyof T & string]: PartMarker<K> } {
    const out: Record<string, PartMarker> = {};
    for (const k in spec) out[k] = new PartMarker(k, spec[k], this);
    return out as { readonly [K in keyof T & string]: PartMarker<K> };
  }
}

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
  ...markers: readonly { color: Signal<string | null> }[]
): void {
  for (const m of markers) m.color.value = color;
}

/** Wire hover on each `Part.el` to its `Marker`; drive `highlighted`
 *  from `active`. Unmatched names are silently skipped. */
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

export type PartList<Names extends string = string> = readonly Part[] & {
  readonly [K in Names]: Part<K>;
};

