// Marker: a named reactive identity shared across diagram, prose, and animation.
//
// A marker carries two signals — `color` and `active` — that can be bound to
// any number of renderings simultaneously. `active` is derived as the OR over
// all bound local signals, so simultaneous activations from multiple sources
// (two hovered elements, an animation and a hover, …) are counted correctly:
// none can "lose" to another's mouseleave.
//
// Self-contained: `marker`, `palette`, `hover`, `getMarker`, `registerMarker`
// are all here. Import one module, get everything needed to build with identity.
//
// Usage:
//
//      // Create
//      const [m, v, h] = palette(3);
//      m.register("post:m");
//
//      // Wire a DOM element's hover (prose, shape, anything)
//      disposer = hover(el, m);
//
//      // Wire an animation
//      const local = cell(true);
//      const unbind = m.bind(local);
//      yield* wait(dt);
//      unbind();
//
//      // Suspend until active
//      yield* untilTrue(m.active);

import { cell, type Cell, type ReadonlyCell } from "./cell";

// ── Registry ──────────────────────────────────────────────────────────────────

const registry = new Map<string, Marker>();

/** Look up a registered marker by id. */
export function getMarker(id: string): Marker | undefined {
  return registry.get(id);
}

/** Register any `Marker`-shaped object under `id`. Used internally by
 *  `marker().register()` and by `PartMarker.register()` to self-register. */
export function registerMarker(id: string, m: Marker): void {
  registry.set(id, m);
}

// ── Type ──────────────────────────────────────────────────────────────────────

/** A named reactive identity shared across any number of renderings.
 *  All bindings participate in one `active` signal (OR over bound locals)
 *  and one `color` signal. Shapes, tex parts, prose elements, and animations
 *  are all equal participants — no single source "owns" the state. */
export type Marker = {
  /** Identity color applied to all bound renderings. */
  color: Cell<string | null>;
  /** True when any bound rendering is currently active. Derived — cannot
   *  be written directly. Bind a local signal via `bind()` instead. */
  active: ReadonlyCell<boolean>;
  /** Bind a local boolean signal to this marker. While `local` is true,
   *  `marker.active` is true. Returns a disposer. Use for custom sources
   *  (animation, selection, scroll, keyboard, …):
   *
   *      const local = cell(true);
   *      const unbind = m.bind(local);
   *      yield* wait(dt);
   *      unbind();
   */
  bind(local: Cell<boolean>): () => void;
  /** Register in the global lookup under `id` and return `this`. */
  register(id: string): Marker;
};

// ── Factory ───────────────────────────────────────────────────────────────────

/** Create a Marker, optionally pre-seeded with a `color`. */
export function marker(color?: string): Marker {
  const colorCell = cell<string | null>(color ?? null);
  const locals = new Set<Cell<boolean>>();
  const v = cell(0); // bumped on membership change to invalidate derived
  const active = cell.derived(() => {
    v.value; // subscribe to membership changes
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

// ── Sugar ─────────────────────────────────────────────────────────────────────

/** N perceptually equidistant colors via OKLCH hue rotation.
 *  L=0.65 C=0.15 gives clear, accessible colors on light and dark backgrounds
 *  without the manual color picking.
 *
 *      const [mass, vel, height] = palette(3);
 *      mass.register("post:mass");
 */
export function palette(n: number): Marker[] {
  return Array.from({ length: n }, (_, i) =>
    marker(`oklch(0.65 0.15 ${((i / n) * 360).toFixed(1)})`),
  );
}

/** Wire a DOM element's hover into a Marker. Each call creates its own
 *  local binding, so simultaneous hovers from multiple elements are
 *  counted correctly and no mouseleave can clear another element's hover.
 *  Returns a disposer that removes the listeners and unbinds the local.
 *
 *      // In scene() — track cleanup via root.track:
 *      this.root.track(hover(circle.el, m));
 *      // In a custom element:
 *      this.#disposers.push(hover(this, m));
 */
export function hover(el: Element, m: Marker): () => void {
  const local = cell(false);
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
