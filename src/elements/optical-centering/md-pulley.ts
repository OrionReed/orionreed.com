import {
  Anchor, Diagram, Mount, Num, Vec, lens, num, vec,
  circle, drag, label, line, rect, type Writable,
} from "../../minim";

const PULLEY_Y = 100;
const PULLEY_R = 28;
const BOX_W = 36;
const BOX_H = 24;
const TOTAL = 280;

export class MdPulley extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const pulley = vec(view.w.value / 2, PULLEY_Y);

    // Single-pulley Atwood: rope drapes over the wheel, tangent at the
    // LEFT side (box A hangs from there) and the RIGHT side (box B).
    // Constraint: aDrop + bDrop = TOTAL (rope length below the wheel,
    // excluding the constant top-half wrap).
    const aDrop = num(140);
    const bDrop = Num.lens(
      () => TOTAL - aDrop.value,
      (v) => { aDrop.value = TOTAL - v; },
    ) as unknown as Writable<Num>;

    // Box positions: x locked to the tangent on each side; y rides
    // the drop signal. The tangent for a vertical rope on a circle is
    // the leftmost / rightmost point of the wheel.
    const aPos = lens(
      () => ({ x: pulley.value.x - PULLEY_R, y: pulley.value.y + aDrop.value }),
      (p) => { aDrop.value = p.y - pulley.value.y; },
      Vec,
    ) as unknown as Writable<Vec>;
    const bPos = lens(
      () => ({ x: pulley.value.x + PULLEY_R, y: pulley.value.y + bDrop.value }),
      (p) => { bDrop.value = p.y - pulley.value.y; },
      Vec,
    ) as unknown as Writable<Vec>;

    // Tangent attachment points on the wheel.
    const leftTangent = vec(pulley.value.x - PULLEY_R, pulley.value.y);
    const rightTangent = vec(pulley.value.x + PULLEY_R, pulley.value.y);

    s(
      circle(pulley, PULLEY_R, { thin: true }),
      // Tiny hub dot.
      circle(pulley, 2, { fill: true }),
      // Vertical rope segments — tangent at the wheel's side, down to
      // the top of each box.
      line(leftTangent, aPos, { thin: true }),
      line(rightTangent, bPos, { thin: true }),
    );

    const aRect = s(rect(aPos, BOX_W, BOX_H, { fill: "#5b8def", corner: 3 }));
    const bRect = s(rect(bPos, BOX_W, BOX_H, { fill: "#e25c5c", corner: 3 }));
    drag(aRect, aPos);
    drag(bRect, bPos);
    aRect.el.style.cursor = "ns-resize";
    bRect.el.style.cursor = "ns-resize";

    s(
      label(view.top.down(20),
        "drag a weight — rope length is conserved, the other follows opposite",
        { size: 12, align: Anchor.Center, opacity: 0.7 }),
      label(view.bottom.up(16),
        "b = Num.lens(L − a, v ↦ a = L − v) · rope tangent at each side of the wheel",
        { size: 10, align: Anchor.Center, opacity: 0.5 }),
    );
  }
}
