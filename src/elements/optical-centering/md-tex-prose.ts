// Prose-linking demo: `PartMarker.register()` + `<md-tex sym="...">`.
//
// Interactive (not animated): hovering a part in the diagram drives
// marker.highlighted, which highlights the matching <md-tex sym="...">
// in the surrounding prose — and vice versa. Both directions share one
// signal.
//
// Markers are registered at module load time (top-level, not inside
// `scene`), so any <md-tex sym="minim:..."> element resolves the
// registry lookup before DOM elements connect, regardless of DOM order.

import { Diagram, Mount } from "../../minim";
import { parts, tex } from "../../minim/tex";
import type { PartMarker } from "../../minim/tex";

const AMBER  = "#d97706";
const CYAN   = "#0284c7";
const VIOLET = "#7c3aed";

// Module-level registration — runs at import time, before any element connects.
const { m, v, h } = parts("m", "v", "h");
m.color.value = AMBER;
v.color.value = CYAN;
h.color.value = VIOLET;
m.register("minim:m");
v.register("minim:v");
h.register("minim:h");

export class MdTexProse extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 100);

    // Two occurrences of m require distinct part names. m2's group chain
    // points back to m, so rootMarker(m2) = m and m.highlighted drives both.
    const m2 = m.expand({ m2: "m" }).m2;

    // \dfrac forces display-style fraction even in inline math mode.
    // \mathit{g} explicitly renders the gravitational constant in math italic.
    const eq = s(
      tex`E = \dfrac{1}{2}${m.with("m")}${v.with("v^2")} + ${m2}\mathit{g}${h.with("h")}`,
    );
    eq.center.set(view.center);

    // Map each part name to its root marker. Hovering any part writes to
    // the root marker's highlighted signal — both diagram and prose react.
    const partMarkers: Record<string, PartMarker> = { m, v, m2: m, h };
    const cleanups: Array<() => void> = [];

    for (const p of eq.parts) {
      const marker = partMarkers[p.name];
      if (!p.el || !marker) continue;
      p.el.style.cursor = "default";
      const on  = (): void => { marker.highlighted.value = true; };
      const off = (): void => { marker.highlighted.value = false; };
      p.el.addEventListener("mouseenter", on);
      p.el.addEventListener("mouseleave", off);
      cleanups.push(
        () => p.el?.removeEventListener("mouseenter", on),
        () => p.el?.removeEventListener("mouseleave", off),
      );
    }

    this.root.track(() => { for (const fn of cleanups) fn(); });
  }
}
