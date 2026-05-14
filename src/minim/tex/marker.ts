// Marker — named reactive identity linking diagram parts to prose.
//
// Lives in `@minim/tex` alongside `PartMarker` (which composes it).
//
// Canonical usage: scoped to a Diagram instance. Call
// `diagram.registerMarker(id, m)` in `scene()` and use `for="diagram-id"`
// on `<md-tex>` / `<md-marker>`. Markers are scoped so two diagrams on
// the same page can both have a "mass" marker without collisions.
//
//      class MyDiagram extends Diagram {
//        scene(s) {
//          const [m, v] = palette(2);
//          this.registerMarker("m", m);
//          this.registerMarker("v", v);
//          // hover(shape.el, m) wires a shape
//        }
//      }
//
//      <my-diagram id="d"></my-diagram>
//      <md-tex for="d" sym="v">v^2</md-tex>
//
// `getMarker` / `registerMarker` free functions and `marker.register(id)`
// remain for backward compatibility. Prefer the scoped path for new code.

import { cell, type Cell, type ReadonlyCell } from "@minim/core";

// ── Global registry (transitional) ────────────────────────────────────────────

const registry = new Map<string, Marker>();

/** Look up a registered marker by id (global registry). */
export function getMarker(id: string): Marker | undefined {
  return registry.get(id);
}

/** Register a marker by id (global registry). */
export function registerMarker(id: string, m: Marker): void {
  registry.set(id, m);
}

// ── Type ──────────────────────────────────────────────────────────────────────

/** Named reactive identity shared across any number of renderings.
 *  `active` is OR over all bound locals — simultaneous activations
 *  from multiple sources are counted correctly. */
export type Marker = {
  color: Cell<string | null>;
  /** True when any bound rendering is active. Read-only; use `bind()`. */
  active: ReadonlyCell<boolean>;
  /** Bind a local boolean cell. Returns a disposer. */
  bind(local: Cell<boolean>): () => void;
  /** Register in the global lookup under `id` and return `this`. */
  register(id: string): Marker;
};

// ── Factory ───────────────────────────────────────────────────────────────────

/** Create a Marker, optionally pre-seeded with a color. */
export function marker(color?: string): Marker {
  const colorCell = cell<string | null>(color ?? null);
  const locals = new Set<Cell<boolean>>();
  const v = cell(0);
  const active = cell.derived(() => {
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

// ── Sugar ─────────────────────────────────────────────────────────────────────

/** N perceptually equidistant colors via OKLCH hue rotation.
 *
 *      const [mass, vel] = palette(2);
 *      this.registerMarker("mass", mass);
 */
export function palette(n: number): Marker[] {
  return Array.from({ length: n }, (_, i) =>
    marker(`oklch(0.65 0.15 ${((i / n) * 360).toFixed(1)})`),
  );
}

/** Wire a DOM element's hover into a Marker. Returns a disposer.
 *
 *      this.root.track(hover(circle.el, m));   // in scene()
 *      this.#disposers.push(hover(this, m));   // in a custom element
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
