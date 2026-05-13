// Multi-track timeline editor — overlapping clips, drag-to-edit
// handles, one ball driven by all four clip progresses in parallel.

import {
  Diagram,
  Mount,
  Anchor,
  circle,
  computed,
  draggable,
  label,
  line,
  pt,
  rect,
  snapshot,
  timeline,
} from "../../minim";

const STRIP_X = 40;
const STRIP_Y = 24;
const STRIP_PAD = 6;
const TRACK_H = 26;
const TRACK_COUNT = 3;
const STRIP_H_TOTAL = TRACK_H * TRACK_COUNT + STRIP_PAD * 2;

export class MdMultitrack extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 320);

    // Overlap is fine; each clip has its own at + dur.
    const tl = timeline({
      fadeIn:  { at: 0,   dur: 1.0 },
      scale:   { at: 0.4, dur: 2.6 },
      shift:   { at: 0.8, dur: 2.4 },
      fadeOut: { at: 2.8, dur: 0.8 },
    });

    const reset = snapshot(tl.clock);

    // Order matters for render order (later clips draw on top).
    const tracks = [
      { name: "fadeIn",  clip: tl.fadeIn,  row: 0, color: "#5b8def" },
      { name: "fadeOut", clip: tl.fadeOut, row: 0, color: "#e25c5c" },
      { name: "scale",   clip: tl.scale,   row: 1, color: "#f5a623" },
      { name: "shift",   clip: tl.shift,   row: 2, color: "#7ed321" },
    ];

    // ── Strip ─────────────────────────────────────────────────────
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
      s(line(pt(STRIP_X, y), pt(STRIP_X + STRIP_W, y), {
        thin: true, opacity: 0.25,
      }));
    }

    // ── Each clip: body + start/end handles + label ────────────────
    tracks.forEach(({ name, clip, row, color }) => {
      const trackY = STRIP_Y + STRIP_PAD + row * TRACK_H;
      const bodyY = trackY + 2;
      const bodyH = TRACK_H - 4;

      // Body — drag to move the clip.
      const body = s(rect(
        clip.at.derive(a => STRIP_X + a * SCALE.value),
        bodyY,
        clip.dur.derive(d => Math.max(d * SCALE.value, 8)),
        bodyH,
        { fill: color, opacity: 0.78, corner: 3, stroke: "none" },
      ));

      // Capture click offset (clip-time units) so the clip stays under
      // the cursor at the original grab point.
      let clickOffset = 0;
      body.on("pointerdown", (e) => {
        const local = body.toLocal(e as PointerEvent);
        clickOffset = (local.x - STRIP_X) / SCALE.value - clip.at.value;
      });
      draggable(body, (local) => {
        const cursorTime = (local.x - STRIP_X) / SCALE.value;
        clip.at.value = Math.max(0, cursorTime - clickOffset);
      });

      // Start handle — anchored to the body's mid-left, drags `at`
      // while keeping `end` fixed.
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

      // End handle — anchored to the body's mid-right, drags `dur`.
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

    const playX = tl.t.derive((t) => STRIP_X + t * STRIP_W);
    s(line(
      pt(playX, STRIP_Y - 4),
      pt(playX, STRIP_Y + STRIP_H_TOTAL + 4),
      { strokeWidth: 1.5, aside: true },
    ));

    // ── Stage: one ball driven by all four clip progresses ────────
    const STAGE_Y = 210;
    const STAGE_X = view.center.x.value;

    //   fadeIn.t  → opacity ramps up
    //   scale.t   → radius oscillates (sin: 0 at endpoints)
    //   shift.t   → x oscillates the same way
    //   fadeOut.t → opacity ramps down
    const ballX = computed(
      () => STAGE_X + Math.sin(tl.shift.t.value * Math.PI) * 110,
    );
    const ballR = computed(
      () => 18 + Math.sin(tl.scale.t.value * Math.PI) * 28,
    );
    const ballOpacity = computed(
      () => tl.fadeIn.t.value * (1 - tl.fadeOut.t.value),
    );

    s(circle(pt(ballX, STAGE_Y), ballR, {
      fill: "#1a1a1a",
      opacity: ballOpacity,
    }));

    // ── Footer ─────────────────────────────────────────────────────
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

    this.anim.loop(function* () {
      reset();
      yield* tl;
      yield 0.4;
    });
  }
}
