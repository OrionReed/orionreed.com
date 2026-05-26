import { circle, Diagram, debug, handle, label, Mount, rect } from "../../minim";

export class MdHandles extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(680, 360);

    const a = s(circle(view.left.right(110).up(50), 18, { fill: "#5b8def" }));
    const b = s(circle(view.left.right(220).up(50), 18, { fill: "#f5a623" }));
    const c = s(circle(view.left.right(165).down(60), 18, { fill: "#e25c5c" }));

    s(debug.distance(a, b), debug.distance(b, c), debug.distance(c, a));

    s(handle.move(a), handle.move(b), handle.move(c), handle.centroid(a, b, c));

    const r = s(rect(0, 0, 110, 76, { thin: true, corner: 4 }));
    r.center.value = view.right.left(120).peek();

    s(debug.box(r), debug.origin(r));

    s(handle.move(r), handle.rotate(r, 70));

    s(
      label(view.top.down(20), "drag any blue handle — vertices, centroid, rotate"),
      label(
        view.bottom.up(16),
        "handle(point) is the atom · move / centroid / rotate are 1-line sugar",
        { size: 10 },
      ),
    );
  }
}
