// minim/tex demo: live data flowing into an equation.
//
// A horizontal slider drives `n: Signal<number>` ∈ [1, 10]. The
// sum bound and the closed-form value on the other side of the
// equation are both Parts whose content is a `computed` of `n`,
// so they re-render whenever the slider moves.
//
// Authoring shape:
//
//      const n = signal(5);
//      const nStr = computed(() => String(n.value));
//      const sumStr = computed(() => String(n.value * (n.value + 1) / 2));
//      const eq = tex`\sum_{i=1}^{${part("n", nStr)}} i = ${part("s", sumStr)}`;
//
// The reactive content path lives in `tex.ts` — when any part's
// content signal changes, the host re-renders, re-measures, and
// re-binds. No special "live" primitive needed; signals all the way.

import {
  Anchor,
  Diagram,
  Mount,
  computed,
  handle,
  label,
  lensPoint,
  line,
  pt,
  signal,
  type Content,
} from "../../minim";
import { part, tex, tint } from "../../minim/tex";

const W = 640;
const H = 220;
const TRACK_Y = 170;
const TRACK_X0 = 120;
const TRACK_X1 = 520;
const N_MIN = 1;
const N_MAX = 10;

// Block-mode tex so the sum's bounds sit above/below the operator
// (the proper display-mode rendering for the sum operator).
const big = tex({ size: 30, display: "block" });

// LaTeX operator extracted as a JS-string constant. Putting `_{i=1}`
// inline in a raw-template literal trips Cursor's TS grammar (it
// reads the `i=1` as an assignment expression and bleeds wrong-state
// forward). As a JS string it splices through to LaTeX unchanged.
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

    // ── Slider state ────────────────────────────────────────────────
    // `t` ∈ [0, 1] is the raw slider position. `n` quantizes it to
    // an integer in [N_MIN, N_MAX]. `nStr` and `sumStr` are the
    // string forms spliced into the equation as part contents.
    const t = signal(0.4);
    const n = computed(() =>
      Math.round(N_MIN + t.value * (N_MAX - N_MIN)),
    );
    const nStr = computed(() => String(n.value));
    const sumStr = computed(() =>
      String((n.value * (n.value + 1)) / 2),
    );

    // ── Slider track + handle ───────────────────────────────────────
    const trackW = TRACK_X1 - TRACK_X0;
    s(
      line(pt(TRACK_X0, TRACK_Y), pt(TRACK_X1, TRACK_Y), {
        thin: true,
        opacity: 0.4,
      }),
    );
    // Lens-backed Point: reads project `t` onto the track; writes
    // clamp the dragged x back into [0, 1] and store as `t`.
    const knobPos = lensPoint(
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

    // Live readout next to the slider.
    s(
      label(pt(TRACK_X0 - 16, TRACK_Y), nStr, {
        size: 13,
        align: Anchor.Right,
        opacity: 0.7,
      }),
    );
    s(
      label(pt(TRACK_X1 + 16, TRACK_Y), `1..${N_MAX}` as Content, {
        size: 11,
        align: Anchor.Left,
        opacity: 0.4,
      }),
    );

    // Two reactive parts: the sum's upper bound and the closed-form
    // result. Both contents are signals over `t`, so the tex shape
    // re-renders whenever the slider moves.
    const nBound = part("n", nStr);
    const result = part("s", sumStr);
    const eq = s(big`${SUM_LOWER}^{${nBound}} i = ${result}`);
    eq.center.set(pt(W / 2, 90));

    // Tag the live parts with an accent color so the eye knows
    // which glyphs respond to the slider.
    tint("#5b8def", nBound, result);
  }
}
