import {Diagram, Mount, Anchor, signal, circle, computed, draggable, label, line, loop, vec, rect, snapshot, timeline} from "../../minim";

const STRIP_X = 40;
const STRIP_Y = 24;
const STRIP_PAD = 6;
const TRACK_H = 26;
const TRACK_COUNT = 3;
const STRIP_H_TOTAL = TRACK_H * TRACK_COUNT + STRIP_PAD * 2;

export class MdMultitrack extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 320);

    const tl = timeline({
      fadeIn:  { at: 0,   dur: 1.0 },
      scale:   { at: 0.4, dur: 2.6 },
      shift:   { at: 0.8, dur: 2.4 },
      fadeOut: { at: 2.8, dur: 0.8 },
    });

    const reset = snapshot(tl.clock);

    // Order = render order; later clips draw on top.
    const tracks = [
      { name: "fadeIn",  clip: tl.fadeIn,  row: 0, color: "#5b8def" },
      { name: "fadeOut", clip: tl.fadeOut, row: 0, color: "#e25c5c" },
      { name: "scale",   clip: tl.scale,   row: 1, color: "#f5a623" },
      { name: "shift",   clip: tl.shift,   row: 2, color: "#7ed321" },
    ];

    const STRIP_W = view.w.value - 2 * STRIP_X;
    const SCALE = computed(() =>
      tl.duration.value > 0 ? STRIP_W / tl.duration.value : 0,
    );

    s(rect(STRIP_X, STRIP_Y, STRIP_W, STRIP_H_TOTAL, {
      fill: "#f5f5f5",
      stroke: "none",
      corner: 4,
    }));
    for (let i = 1; i < TRACK_COUNT; i++) {
      const y = STRIP_Y + STRIP_PAD + i * TRACK_H;
      s(line(vec(STRIP_X, y), vec(STRIP_X + STRIP_W, y), {
        thin: true, opacity: 0.25,
      }));
    }

    tracks.forEach(({ name, clip, row, color }) => {
      const trackY = STRIP_Y + STRIP_PAD + row * TRACK_H;
      const bodyY = trackY + 2;
      const bodyH = TRACK_H - 4;

      const body = s(rect(
        computed(() => (a => STRIP_X + a * SCALE.value)(clip.at.value)),
        bodyY,
        computed(() => (d => Math.max(d * SCALE.value, 8))(clip.dur.value)),
        bodyH,
        { fill: color, opacity: 0.78, corner: 3, stroke: "none" },
      ));

      // Click offset in clip-time units — keeps the grab point under the cursor.
      let clickOffset = 0;
      body.on("pointerdown", (e) => {
        const local = body.toLocal(e as PointerEvent);
        clickOffset = (local.x - STRIP_X) / SCALE.value - clip.at.value;
      });
      draggable(body, (local) => {
        const cursorTime = (local.x - STRIP_X) / SCALE.value;
        clip.at.value = Math.max(0, cursorTime - clickOffset);
      });

      const startKnob = s(circle(body.left, 4.5, {
        fill: color, stroke: "white", strokeWidth: 1.5,
      }));
      let snapEnd = 0;
      startKnob.on("pointerdown", () => {
        snapEnd = clip.at.value + clip.dur.value;
      });
      draggable(startKnob, (local) => {
        const cursorTime = (local.x - STRIP_X) / SCALE.value;
        const newAt = Math.min(Math.max(0, cursorTime), snapEnd - 0.05);
        clip.at.value = newAt;
        clip.dur.value = snapEnd - newAt;
      });

      const endKnob = s(circle(body.right, 4.5, {
        fill: color, stroke: "white", strokeWidth: 1.5,
      }));
      let snapAt = 0;
      endKnob.on("pointerdown", () => {
        snapAt = clip.at.value;
      });
      draggable(endKnob, (local) => {
        const cursorTime = (local.x - STRIP_X) / SCALE.value;
        clip.dur.value = Math.max(0.05, cursorTime - snapAt);
      });

      s(label(body.center, name, {
        size: 10, opacity: 0.95, align: Anchor.Center,
      }));
    });

    const playX = computed(() => ((t) => STRIP_X + t * STRIP_W)(tl.t.value));
    s(line(
      vec(playX, STRIP_Y - 4),
      vec(playX, STRIP_Y + STRIP_H_TOTAL + 4),
      { strokeWidth: 1.5, aside: true },
    ));

    const STAGE_Y = 210;

    const ballX = computed(
      () => view.center.x.value + Math.sin(tl.shift.t.value * Math.PI) * 110,
    );
    const ballR = computed(
      () => 18 + Math.sin(tl.scale.t.value * Math.PI) * 28,
    );
    const ballOpacity = computed(
      () => tl.fadeIn.t.value * (1 - tl.fadeOut.t.value),
    );

    s(circle(vec(ballX, STAGE_Y), ballR, {
      fill: "#1a1a1a",
      opacity: ballOpacity,
    }));

    s(
      label(
        view.bottom.up(32),
        computed(() =>
          `time: ${tl.clock.value.toFixed(2)}s / ${tl.duration.value.toFixed(2)}s`,
        ),
        { size: 11, opacity: 0.65, align: Anchor.Center },
      ),
      label(
        view.bottom.up(14),
        "drag clip body to shift · drag handles to resize · overlapping clips animate together",
        { size: 10, opacity: 0.5, align: Anchor.Center },
      ),
    );

    this.anim.start(loop(function* () {
      reset();
      yield* tl;
      yield 0.4;
    }));
  }
}
