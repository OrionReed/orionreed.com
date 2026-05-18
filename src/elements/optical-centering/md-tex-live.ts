import {Anchor, Diagram, Mount, Vec, signal, computed, derived, handle, label, line, vec, type Content} from "../../minim";
import {part, tex, tint} from "../../minim/tex";

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
      label(view.top.down(20), "tex — live data into an equation", {
        size: 12,
        opacity: 0.55,
        align: Anchor.Center,
      }),
      label(
        view.bottom.up(14),
        "drag the blue handle ↔ both sides re-render reactively",
        { size: 10, opacity: 0.45, align: Anchor.Center },
      ),
    );

    const t = signal(0.4);
    const n = computed(() =>
      Math.round(N_MIN + t.value * (N_MAX - N_MIN)),
    );
    const nStr = computed(() => String(n.value));
    const sumStr = computed(() =>
      String((n.value * (n.value + 1)) / 2),
    );

    const trackW = TRACK_X1 - TRACK_X0;
    s(
      line(vec(TRACK_X0, TRACK_Y), vec(TRACK_X1, TRACK_Y), {
        thin: true,
        opacity: 0.4,
      }),
    );
    const knobPos = derived(Vec,
      () => ({ x: TRACK_X0 + t.value * trackW, y: TRACK_Y }),
      (target) => {
        const clamped = Math.max(
          0,
          Math.min(1, (target.x - TRACK_X0) / trackW),
        );
        t.value = clamped;
      },
    );
    s(handle(knobPos));

    s(
      label(vec(TRACK_X0 - 16, TRACK_Y), nStr, {
        size: 13,
        align: Anchor.Right,
        opacity: 0.7,
      }),
    );
    s(
      label(vec(TRACK_X1 + 16, TRACK_Y), `1..${N_MAX}` as Content, {
        size: 11,
        align: Anchor.Left,
        opacity: 0.4,
      }),
    );

    const nBound = part("n", nStr);
    const result = part("s", sumStr);
    const eq = s(big`${SUM_LOWER}^{${nBound}} i = ${result}`);
    eq.center.set(vec(W / 2, 90));

    tint("#5b8def", nBound, result);
  }
}
