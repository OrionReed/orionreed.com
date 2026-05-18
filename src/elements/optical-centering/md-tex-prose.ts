import {Diagram, Mount} from "../../minim";
import {parts, tex, bindParts} from "../../minim/tex";

// Module-level so <md-marker> elements resolve before any element connects.
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

    // Two occurrences of m need distinct part names; m2's group chain points to m.
    const m2 = m.expand({ m2: "m" }).m2;

    const eq = s(
      tex`E = \dfrac{1}{2}${m.with("m")}${v.with("v^2")} + ${m2}\mathit{g}${h.with("h")}`,
    );
    eq.center.set(view.center);

    this.root.track(bindParts(eq, { m, v, m2, h }));
  }
}
