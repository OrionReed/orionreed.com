import {
  Anchor, Diagram, Mount, Vec, num, vec,
  circle, drag, label, line, rect, type Writable, type Num,
} from "../../minim";

const PULLEY_Y = 100;
const PULLEY_R = 28;
const TOTAL = 280;

export class MdPulley extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const pulley = vec(view.w.value / 2, PULLEY_Y);
    const leftTan = pulley.left(PULLEY_R);
    const rightTan = pulley.right(PULLEY_R);

    // Conservation: bDrop + aDrop = TOTAL, i.e. bDrop = −aDrop + TOTAL.
    // `affine(k, off)` is invertible; writes to bDrop propagate back
    // through to aDrop. No manual lens.
    const aDrop = num(140);
    const bDrop = aDrop.affine(-1, TOTAL);

    // A weight hangs from its tangent on the wheel: x locked to the
    // tangent, y rides the drop signal. Drag writes back through y.
    const hang = (tangent: Vec, drop: Writable<Num>) =>
      Vec.lens(
        () => ({ x: tangent.value.x, y: tangent.value.y + drop.value }),
        (p) => { drop.value = p.y - tangent.value.y; },
      );
    const aPos = hang(leftTan, aDrop);
    const bPos = hang(rightTan, bDrop);

    s(
      circle(pulley, PULLEY_R, { thin: true }),
      circle(pulley, 2, { fill: true }),
      line(leftTan, aPos, { thin: true }),
      line(rightTan, bPos, { thin: true }),
    );

    const aRect = s(rect(aPos, 36, 24, { fill: "#5b8def", corner: 3 }));
    const bRect = s(rect(bPos, 36, 24, { fill: "#e25c5c", corner: 3 }));
    drag(aRect, aPos);
    drag(bRect, bPos);
    aRect.el.style.cursor = "ns-resize";
    bRect.el.style.cursor = "ns-resize";

    s(
      label(view.top.down(20),
        "drag a weight — rope length is conserved, the other follows opposite",
        { size: 12, align: Anchor.Center, opacity: 0.7 }),
      label(view.bottom.up(16),
        "b = a.affine(−1, L) · the invertible chain IS the conservation law",
        { size: 10, align: Anchor.Center, opacity: 0.5 }),
    );
  }
}
