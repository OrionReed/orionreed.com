import {
  Anchor,
  Diagram,
  handle,
  label,
  line,
  Mount,
  reflectionLens,
  Vec,
  vec,
  type Writable,
} from "../../minim";

export class MdMirror extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(720, 360);

    const mA = vec(360, 30);
    const mB = vec(360, 330);

    // Reflection is an involution — `reflectionLens` reads `reflect(src,
    // mA, mB)` and on writes applies the same formula to land back in
    // src. The lens is itself a 3-input fanin; only `src` is updated
    // on writes (the axis stays put).
    const mirrorOf = (src: Writable<Vec>): Writable<Vec> => reflectionLens(src, mA, mB);

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
      label(view.top.down(20), "drag any handle — original, reflected, or the mirror itself", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        "reflectionLens(p, mA, mB)  ·  one involutive formula, both directions",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
