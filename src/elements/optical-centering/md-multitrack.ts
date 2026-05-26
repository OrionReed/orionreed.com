import {
  Anchor,
  circle,
  computed,
  Diagram,
  draggable,
  label,
  line,
  loop,
  Mount,
  rect,
  snapshot,
  timeline,
  vec,
} from "../../minim";

const STRIP_X = 40;
const STRIP_Y = 24;
const STRIP_PAD = 6;
const TRACK_H = 26;
const TRACK_COUNT = 3;
const STRIP_H_TOTAL = TRACK_H * TRACK_COUNT + STRIP_PAD * 2;
const MIN_W_PX = 8;

export class MdMultitrack extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 320);

    const tl = timeline({
      fadeIn: { at: 0, dur: 1.0 },
      scale: { at: 0.4, dur: 2.6 },
      shift: { at: 0.8, dur: 2.4 },
      fadeOut: { at: 2.8, dur: 0.8 },
    });

    const reset = snapshot(tl.clock);

    // Order = render order; later clips draw on top.
    const tracks = [
      { name: "fadeIn", clip: tl.fadeIn, row: 0, color: "#5b8def" },
      { name: "fadeOut", clip: tl.fadeOut, row: 0, color: "#e25c5c" },
      { name: "scale", clip: tl.scale, row: 1, color: "#f5a623" },
      { name: "shift", clip: tl.shift, row: 2, color: "#7ed321" },
    ];

    const STRIP_W = view.w.value - 2 * STRIP_X;
    const SCALE = computed(() => (tl.duration.value > 0 ? STRIP_W / tl.duration.value : 0));

    s(
      rect(STRIP_X, STRIP_Y, STRIP_W, STRIP_H_TOTAL, {
        fill: "#f5f5f5",
        stroke: "none",
        corner: 4,
      }),
    );
    for (let i = 1; i < TRACK_COUNT; i++) {
      const y = STRIP_Y + STRIP_PAD + i * TRACK_H;
      s(
        line(vec(STRIP_X, y), vec(STRIP_X + STRIP_W, y), {
          thin: true,
          opacity: 0.25,
        }),
      );
    }

    tracks.forEach(({ name, clip, row, color }) => {
      const trackY = STRIP_Y + STRIP_PAD + row * TRACK_H;
      const bodyY = trackY + 2;
      const bodyH = TRACK_H - 4;

      // Time-space clip span (`[at, at + dur]` as a `Range`), chained
      // into pixel space:
      //   px = (time-range · SCALE) + STRIP_X
      // The chain is a single fused lens — writes to `px.lo` / `.hi` /
      // `.start` round-trip back through to `clip.at` / `clip.dur` with
      // no conversion math at the call site.
      const px = clip.span.scale(SCALE).shift(STRIP_X);

      const renderedW = computed(() => Math.max(px.width.value, MIN_W_PX));

      const body = s(
        rect(px.lo, bodyY, renderedW, bodyH, {
          fill: color,
          opacity: 0.78,
          corner: 3,
          stroke: "none",
        }),
      );

      // Click offset in pixels — body-drag writes pixels directly via
      // the chained lens; the underlying time signals follow.
      let clickOffsetPx = 0;
      body.on("pointerdown", e => {
        const local = body.toLocal(e as PointerEvent);
        clickOffsetPx = local.x - px.lo.value;
      });
      draggable(body, local => {
        // Clamp to the strip's left edge in pixel space; preserves
        // duration via Range#start (body-drag handle).
        px.start.value = Math.max(STRIP_X, local.x - clickOffsetPx);
      });

      const startKnob = s(
        circle(body.left, 4.5, {
          fill: color,
          stroke: "white",
          strokeWidth: 1.5,
        }),
      );
      draggable(startKnob, local => {
        // Drag the start in pixel space, end stays put. Range#lo is
        // the start-knob field lens (preserves hi).
        px.lo.value = Math.min(local.x, px.hi.value - MIN_W_PX);
      });

      const endKnob = s(
        circle(body.right, 4.5, {
          fill: color,
          stroke: "white",
          strokeWidth: 1.5,
        }),
      );
      draggable(endKnob, local => {
        // Drag the end in pixel space, start stays put.
        px.hi.value = Math.max(local.x, px.lo.value + MIN_W_PX);
      });

      s(
        label(body.center, name, {
          size: 10,
          opacity: 0.95,
          align: Anchor.Center,
        }),
      );
    });

    const playX = computed(() => STRIP_X + tl.t.value * STRIP_W);
    s(
      line(vec(playX, STRIP_Y - 4), vec(playX, STRIP_Y + STRIP_H_TOTAL + 4), {
        strokeWidth: 1.5,
        aside: true,
      }),
    );

    const STAGE_Y = 210;

    const ballX = computed(() => view.center.x.value + Math.sin(tl.shift.t.value * Math.PI) * 110);
    const ballR = computed(() => 18 + Math.sin(tl.scale.t.value * Math.PI) * 28);
    const ballOpacity = computed(() => tl.fadeIn.t.value * (1 - tl.fadeOut.t.value));

    s(
      circle(vec(ballX, STAGE_Y), ballR, {
        fill: "#1a1a1a",
        opacity: ballOpacity,
      }),
    );

    s(
      label(
        view.bottom.up(32),
        computed(() => `time: ${tl.clock.value.toFixed(2)}s / ${tl.duration.value.toFixed(2)}s`),
        { size: 11, opacity: 0.65, align: Anchor.Center },
      ),
      label(
        view.bottom.up(14),
        "drag clip body to shift · drag handles to resize · overlapping clips animate together",
        { size: 10, opacity: 0.5, align: Anchor.Center },
      ),
    );

    this.anim.start(
      loop(function* () {
        reset();
        yield* tl;
        yield 0.4;
      }),
    );
  }
}
