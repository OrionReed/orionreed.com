// md-scene-graph.ts — parent / children via `w()`.
//
// A parent Vec; three children, each = parent.offset(w(dx), w(dy)).
// Drag a child → only its local offset moves; parent and siblings
// stay. Drag the parent → every child follows (forward propagation
// through the offsets).
//
// This is the standard scene-graph idiom expressed in one line per
// child: the child is just `parent.offset(w(localX), w(localY))`. No
// special "scene graph" type; no derived `world` cell that has to be
// rewritten on parent move; no per-child manual sync code. The lens's
// bwd cascade does the right thing in each direction.

import {
  Anchor,
  circle,
  Diagram,
  drag,
  label,
  line,
  type Mount,
  num,
  type Num,
  vec,
  w,
  type Writable,
} from "../../minim";

const W = 640;
const H = 280;

interface Child {
  dx: Writable<Num>;
  dy: Writable<Num>;
  fill: string;
  glyph: string;
}

export class MdSceneGraph extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    const parent = vec(W / 2, H / 2);

    const children: Child[] = [
      { dx: num(-90), dy: num(-50), fill: "#5b8def", glyph: "A" },
      { dx: num(100), dy: num(-30), fill: "#7ed321", glyph: "B" },
      { dx: num(40), dy: num(70), fill: "#e25c5c", glyph: "C" },
    ];

    s(
      label(
        view.top.down(16),
        "drag parent → children follow · drag a child → only its local offset moves",
      ),
    );

    // Connector lines from parent to each child (purely visual).
    for (const c of children) {
      const childPos = parent.offset(w(c.dx), w(c.dy));
      s(line(parent, childPos, { stroke: "#bcd9e8", strokeWidth: 1.5, cap: "round" }));
    }

    // Child handles.
    for (const c of children) {
      const childPos = parent.offset(w(c.dx), w(c.dy));
      const handle = s(circle(childPos, 16, { fill: c.fill, stroke: "white", strokeWidth: 2 }));
      drag(handle, childPos);
      handle.el.style.cursor = "move";
      s(label(childPos, c.glyph, { size: 12, bold: true, fill: "white", align: Anchor.Center }));
    }

    // Parent handle (drawn last so it sits on top).
    const ph = s(
      circle(parent, 12, {
        fill: "#222",
        stroke: "white",
        strokeWidth: 2,
        opacity: 0.85,
      }),
    );
    drag(ph, parent);
    ph.el.style.cursor = "move";
    s(
      label(parent.down(24), "parent", {
        size: 11,
        bold: true,
        fill: "var(--text-color, #333)",
        align: Anchor.Center,
      }),
    );

    s(
      label(
        view.bottom.up(10),
        "child = parent.offset(w(dx), w(dy)) — one line per child, full bidirectional behavior",
        { size: 9.5 },
      ),
    );
  }
}
