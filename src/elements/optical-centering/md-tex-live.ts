import {
  Anchor,
  type Content,
  Diagram,
  derive,
  handle,
  label,
  line,
  type Mount,
  num,
  Vec,
  vec,
} from "../../minim";
import { part, tex, tint } from "../../minim/tex";

const W = 640;
const H = 220;
const TRACK_Y = 170;
const TRACK_X0 = 120;
const TRACK_X1 = 520;
const N_MIN = 1;
const N_MAX = 10;

const big = tex({ size: 30, display: "block" });

// JS-string constant: `_{i=1}` inline in a raw template trips Cursor's TS grammar.
const SUM_LOWER = "\\sum_{i=1}";

export class MdTexLive extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    s(
      label(view.top.down(20), "tex — live data into an equation"),
      label(view.bottom.up(14), "drag the blue handle ↔ both sides re-render reactively", {
        size: 10,
      }),
    );

    const t = num(0.4);
    const n = derive(() => Math.round(N_MIN + t.value * (N_MAX - N_MIN)));
    const nStr = derive(() => String(n.value));
    const sumStr = derive(() => String((n.value * (n.value + 1)) / 2));

    const trackW = TRACK_X1 - TRACK_X0;
    s(
      line(vec(TRACK_X0, TRACK_Y), vec(TRACK_X1, TRACK_Y), {
        thin: true,
        opacity: 0.4,
      }),
    );
    // Slider math is a clamp + affine chain on `t`: clip to [0,1], then
    // map to screen x. Both halves of the chain are invertible, so
    // dragging the knob writes back through `affine` and `clamp` into
    // `t`. No manual lens; just the algebra.
    const knobX = t.clamp(0, 1).affine(trackW, TRACK_X0);
    const knobPos = Vec.lens(
      () => ({ x: knobX.value, y: TRACK_Y }),
      p => {
        knobX.value = p.x;
      },
    );
    s(handle(knobPos));

    s(label(vec(TRACK_X0 - 16, TRACK_Y), nStr, { align: Anchor.Right }));
    s(
      label(vec(TRACK_X1 + 16, TRACK_Y), `1..${N_MAX}` as Content, {
        align: Anchor.Left,
        opacity: 0.4,
      }),
    );

    const nBound = part("n", nStr);
    const result = part("s", sumStr);
    const eq = s(big`${SUM_LOWER}^{${nBound}} i = ${result}`);
    eq.center.value = vec(W / 2, 90).peek();

    tint("#5b8def", nBound, result);
  }
}
