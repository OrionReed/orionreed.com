import {
  Anchor, Diagram, Mount,
  Vec, type VecValue, derived,
  handle, label, line, vec,
} from "../../minim";

/** Reflect `p` across line a–b; returns `p` unchanged when a==b. */
function reflect(p: VecValue, a: VecValue, b: VecValue): VecValue {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return p;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const fx = a.x + t * dx;
  const fy = a.y + t * dy;
  return { x: 2 * fx - p.x, y: 2 * fy - p.y };
}

export class MdMirror extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(720, 360);

    const mA = vec(360, 30);
    const mB = vec(360, 330);

    // Reflection is an involution — same formula reads and writes.
    const mirrorOf = (src: Vec): Vec =>
      derived(Vec,
        () => reflect(src.value, mA.value, mB.value),
        (target) => {
          src.value = reflect(target, mA.value, mB.value);
        },
      );

    const stemTop = vec(200, 90);
    const stemBot = vec(200, 270);
    const topRight = vec(280, 90);
    const midRight = vec(260, 180);
    const F = "#5b8def";

    const stemMid = stemTop.lerp(stemBot, 0.5);

    s(
      line(stemTop, stemBot, { stroke: F, strokeWidth: 4 }),
      line(stemTop, topRight, { stroke: F, strokeWidth: 4 }),
      line(stemMid, midRight, { stroke: F, strokeWidth: 4 }),
    );

    const stemTopR = mirrorOf(stemTop);
    const stemBotR = mirrorOf(stemBot);
    const topRightR = mirrorOf(topRight);
    const midRightR = mirrorOf(midRight);
    const FR = "#e25c5c";

    const stemMidR = stemTopR.lerp(stemBotR, 0.5);

    s(
      line(stemTopR, stemBotR, { stroke: FR, strokeWidth: 4 }),
      line(stemTopR, topRightR, { stroke: FR, strokeWidth: 4 }),
      line(stemMidR, midRightR, { stroke: FR, strokeWidth: 4 }),
    );

    s(line(mA, mB, { thin: true, dashed: true, opacity: 0.5 }));

    s(
      handle(stemTop),
      handle(stemBot),
      handle(topRight),
      handle(midRight),
      handle(stemTopR),
      handle(stemBotR),
      handle(topRightR),
      handle(midRightR),
      handle(mA),
      handle(mB),
    );

    s(
      label(
        view.top.down(20),
        "drag any handle — original, reflected, or the mirror itself",
        { size: 12, align: Anchor.Center, opacity: 0.7 },
      ),
      label(
        view.bottom.up(16),
        "lens(read = reflect,  write = reflect)  ·  one formula, both directions",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
