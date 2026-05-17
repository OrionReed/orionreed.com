// Prose-linking demo: markers + tex parts wired bidirectionally.
//
// Hover any part in the formula or any word in the prose and the
// corresponding parts in both light up simultaneously. Both ends
// share one `marker.active` signal via `bindParts`.
//
// Markers are registered at module load time so <md-marker> elements
// in the page resolve the lookup before DOM elements connect, regardless
// of DOM order.

import {Diagram, Mount} from "../../minim";
import {parts, tex, bindParts} from "../../minim/tex";

// Module-level: create PartMarkers (needed for with/expand in tex templates)
// and assign equidistant OKLCH colors. Three equally-spaced hues at a
// comfortable lightness/chroma so they work on light and dark backgrounds.
const { m, v, h } = parts("m", "v", "h");
[m, v, h].forEach((p, i) => {
  p.color.value = `oklch(0.65 0.15 ${((i / 3) * 360).toFixed(1)})`;
});
m.register("minim:m");
v.register("minim:v");
h.register("minim:h");

export class MdTexProse extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 100);

    // Two occurrences of m in one template need distinct part names.
    // m2's group chain points to m, so hover on either activates the m marker.
    const m2 = m.expand({ m2: "m" }).m2;

    const eq = s(
      tex`E = \dfrac{1}{2}${m.with("m")}${v.with("v^2")} + ${m2}\mathit{g}${h.with("h")}`,
    );
    eq.center.set(view.center);

    // Wire hover on each Part.el → marker, and marker.active → part.highlighted.
    this.root.track(bindParts(eq, { m, v, m2, h }));
  }
}
