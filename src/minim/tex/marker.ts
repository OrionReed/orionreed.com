// Named reactive identity linking diagram parts to prose. Prefer the
// scoped registration on `Diagram` over the global registry below.

import {computed, signal, type Signal} from "@minim/signals";

const registry = new Map<string, Marker>();

export function getMarker(id: string): Marker | undefined {
  return registry.get(id);
}

export function registerMarker(id: string, m: Marker): void {
  registry.set(id, m);
}

/** Identity shared across renderings; `active` is OR over bound locals. */
export type Marker = {
  color: Signal<string | null>;
  active: Signal<boolean>;
  bind(local: Signal<boolean>): () => void;
  register(id: string): Marker;
};

export function marker(color?: string): Marker {
  const colorCell = signal<string | null>(color ?? null);
  const locals = new Set<Signal<boolean>>();
  const v = signal(0);
  const active = computed(() => {
    v.value;
    for (const s of locals) if (s.value) return true;
    return false;
  });
  const m: Marker = {
    color: colorCell,
    active,
    bind(local) {
      locals.add(local);
      v.value++;
      return () => {
        locals.delete(local);
        v.value++;
      };
    },
    register(id) {
      registry.set(id, m);
      return m;
    },
  };
  return m;
}

/** N perceptually-equidistant OKLCH colors. */
export function palette(n: number): Marker[] {
  return Array.from({ length: n }, (_, i) =>
    marker(`oklch(0.65 0.15 ${((i / n) * 360).toFixed(1)})`),
  );
}

/** 15%-opacity background tint used for marker / part highlights. */
export const highlightTint = (color: string): string =>
  `color-mix(in srgb, ${color} 15%, transparent)`;

/** Wire a DOM element's hover into a Marker. */
export function hover(el: Element, m: Marker): () => void {
  const local = signal(false);
  const unbind = m.bind(local);
  const on  = (): void => { local.value = true; };
  const off = (): void => { local.value = false; };
  el.addEventListener("mouseenter", on);
  el.addEventListener("mouseleave", off);
  return (): void => {
    unbind();
    el.removeEventListener("mouseenter", on);
    el.removeEventListener("mouseleave", off);
  };
}
