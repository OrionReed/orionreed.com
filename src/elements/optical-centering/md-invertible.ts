import { circle, Diagram, debug, handle, label, line, Mount, vec } from "../../minim";

export class MdInvertible extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(480, 240);

    // Writable source point; literals give a forward-only Writable<Vec>,
    // which is fine — `a` itself owns the state.
    const a = vec(view.w.value * 0.3, view.h.value * 0.7);

    // Derived via `.right` and `.up` — both are invertible chains, so
    // `b` is a Writable<Vec> whose writes flow back through to `a`.
    const b = a.right(160).up(80);

    s(line(a, b, { thin: true, dashed: true, opacity: 0.4 }));
    s(debug.distance(a, b));

    s(circle(a, 16, { fill: "#5b8def" }));
    s(circle(b, 16, { fill: "#e25c5c" }));

    s(handle(a), handle(b));

    s(
      label(view.top.down(20), "drag either dot — the invertible chain writes both ways"),
      label(view.bottom.up(16), "b = a.right(160).up(80) · same lens read & written", {
        size: 10,
      }),
    );
  }
}
