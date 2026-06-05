import { circle, Diagram, drag, label, line, type Mount, vec } from "../../minim";

export class MdInvertible extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(480, 240);

    // Writable source point; literals give a forward-only Writable<Vec>,
    // which is fine — `a` itself owns the state.
    const a = vec(view.w.value * 0.3, view.h.value * 0.7);

    // Derived via `.right` and `.up` — both are invertible chains, so
    // `b` is a Writable<Vec> whose writes flow back through to `a`.
    const b = a.right(160).up(80);

    s(line(a, b));

    // The shapes themselves are the drag targets — no separate handle dots.
    const ca = s(circle(a, 16, { fill: "#5b8def" }));
    const cb = s(circle(b, 16, { fill: "#e25c5c" }));
    drag(ca, a);
    drag(cb, b);

    s(
      label(view.top.down(20), "drag either shape — the invertible chain writes both ways"),
      label(view.bottom.up(16), "b = a.right(160).up(80) · same lens read & written", {
        size: 10,
      }),
    );
  }
}
