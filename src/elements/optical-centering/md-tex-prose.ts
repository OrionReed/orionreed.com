// Prose-linking demo: `PartMarker.register()` + `<md-tex sym="...">`.
//
// Demonstrates bidirectional hover linkage between diagram parts and
// prose elements. Both share the same `marker.highlighted` signal:
//   - hovering a prose <md-tex sym="..."> → highlights formula parts
//   - the animation driving marker.highlighted → highlights prose too
//
// Markers are registered at module load time (top-level, not inside
// `scene`), so any `<md-tex sym="minim:...">` element in the page
// resolves the registry lookup before DOM elements connect.

import { Diagram, Mount } from "../../minim";
import { parts, tex } from "../../minim/tex";

const AMBER  = "#d97706";
const CYAN   = "#0284c7";
const VIOLET = "#7c3aed";

// Module-level registration — runs at import time, before any element
// connects. DOM order of <md-tex-prose> relative to <md-tex sym="...">
// elements doesn't matter.
const { m, v, h } = parts("m", "v", "h");
m.color.value = AMBER;
v.color.value = CYAN;
h.color.value = VIOLET;
m.register("minim:m");
v.register("minim:v");
h.register("minim:h");

export class MdTexProse extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 80);

    // Two occurrences of m in one template require distinct part names.
    // m2 is a child of m in the group chain, so rootMarker(m2) = m,
    // and m.highlighted drives both instances.
    const m2 = m.expand({ m2: "m" }).m2;

    const eq = s(
      tex`E = \frac{1}{2}${m.with("m")}${v.with("v^2")} + ${m2}g${h.with("h")}`,
    );
    eq.center.set(view.center);

    // Cycle through highlighting each symbol. Because this writes to
    // marker.highlighted (not part.highlighted), it also drives any
    // <md-tex sym="minim:..."> elements in the surrounding prose.
    this.anim.loop(function* () {
      yield 1.5;
      m.highlighted.value = true;
      yield 0.7;
      m.highlighted.value = false;
      yield 0.5;
      v.highlighted.value = true;
      yield 0.7;
      v.highlighted.value = false;
      yield 0.5;
      h.highlighted.value = true;
      yield 0.7;
      h.highlighted.value = false;
      yield 1.5;
    });
  }
}
