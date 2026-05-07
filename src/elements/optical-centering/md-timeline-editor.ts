// Mini timeline editor: editable named durations driving a looping
// animation. Demonstrates:
//
//   - `timeline(sequential({...}))` for named, edit-friendly clips
//     whose `at`s ripple-update from prior durations.
//   - `clip.t` reactive progress driving opacity directly (no per-frame
//     callback — pure signal binding).
//   - `draggable(knob, fn)` for drag-to-edit knobs.
//   - `bus.emit/on` for click pings + reactive tap counts.
//   - `snapshot(tl.clock)` as the reset pattern for loops.

import {
  Diagram,
  Scene,
  align,
  circle,
  computed,
  css,
  draggable,
  label,
  line,
  pt,
  rect,
  sequential,
  signal,
  snapshot,
  timeline,
} from "../../minim";

const PHASES = ["intro", "hold", "outro"] as const;
const COLORS = ["#5b8def", "#f5a623", "#e25c5c"];
const MAX_DUR = 2.5;

export class MdTimelineEditor extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected scene(s: Scene): void {
    const W = 600;
    const H = 320;
    s.view(0, 0, W, H);

    // ── Editable timeline ─────────────────────────────────────────────
    // `sequential` produces clip specs with cumulative-start `at`s.
    // Editing any `dur` ripples through to subsequent clips' `at`s.
    const tl = timeline(sequential({ intro: 0.7, hold: 1.2, outro: 0.5 }));
    const reset = snapshot(tl.clock);

    // Currently-active clip name (for the header).
    const phaseName = computed(() => {
      for (const name of PHASES) if (tl[name].active.value) return name;
      return tl.clock.value >= tl.duration.value ? "rest" : PHASES[0];
    });
    const taps = signal(0);
    this.bus.on("ping", () => {
      taps.value = taps.peek() + 1;
    });

    // ── Header ────────────────────────────────────────────────────────
    s(
      label(
        pt(W / 2, 24),
        computed(() => `phase: ${phaseName.value}   ·   taps: ${taps.value}`),
        { size: 14, opacity: 0.75 },
      ),
    );

    // ── Timeline strip (top) ──────────────────────────────────────────
    const STRIP_X = 60;
    const STRIP_W = W - 120;
    const STRIP_Y = 60;
    const STRIP_H = 36;
    const scale = computed(() => STRIP_W / tl.duration.value);

    PHASES.forEach((name, i) => {
      const c = tl[name];
      s(
        rect(
          c.at.derive((a) => STRIP_X + a * scale.value),
          STRIP_Y,
          c.dur.derive((d) => d * scale.value),
          STRIP_H,
          { fill: COLORS[i] },
        ),
      );
      s(
        label(
          pt(
            computed(
              () => STRIP_X + (c.at.value + c.dur.value / 2) * scale.value,
            ),
            STRIP_Y + 18,
          ),
          computed(() => `${name} ${c.dur.value.toFixed(2)}s`),
          { size: 11, opacity: 0.95 },
        ),
      );
    });

    // Playhead — derived from `tl.t`, so retiming updates it live.
    const playX = computed(() => STRIP_X + tl.t.value * STRIP_W);
    s(
      line(pt(playX, STRIP_Y - 6), pt(playX, STRIP_Y + STRIP_H + 6), {
        strokeWidth: 2,
      }),
    );

    // ── Slider knobs (middle) ─────────────────────────────────────────
    const SLIDER_Y = 150;
    const SLIDER_GAP = 24;
    const SLIDER_W = (W - 120 - SLIDER_GAP * 2) / 3;

    PHASES.forEach((name, i) => {
      const x0 = 60 + i * (SLIDER_W + SLIDER_GAP);
      // `dur` is editable via the slider — sequential clips produce a
      // writable `Signal<number>` for dur (input was a number).
      const dur = tl[name].dur;

      s(
        line(pt(x0, SLIDER_Y), pt(x0 + SLIDER_W, SLIDER_Y), {
          thin: true,
          opacity: 0.3,
          cap: "round",
        }),
      );

      const knob = s(
        circle(
          pt(() => x0 + (dur.value / MAX_DUR) * SLIDER_W, SLIDER_Y),
          9,
          { fill: COLORS[i] },
        ),
      );
      draggable(knob, (local) => {
        const u = Math.min(Math.max((local.x - x0) / SLIDER_W, 0), 1);
        // Floor at 0.1s so a phase never reaches zero (would freeze the loop).
        dur.value = Math.max(0.1, u * MAX_DUR);
      });
    });

    // ── Stage actors (bottom) — opacity follows clip progress ────────
    const STAGE_Y = 240;
    const actors = PHASES.map((name, i) => {
      const c = circle(pt(120 + i * 180, STAGE_Y), 24, {
        fill: COLORS[i],
        opacity: tl[name].t.derive((t) => 0.1 + t * 0.9),
      });
      c.on("click", () => this.bus.emit("ping"));
      return c;
    });
    actors.forEach((c) => s(c));

    s(
      label(
        pt(W / 2, H - 16),
        "drag the knobs to retime · click any circle to ping",
        { size: 11, opacity: 0.5, align: align.center },
      ),
    );

    // ── Animation flow: replay the timeline forever ───────────────────
    this.anim.loop(function* () {
      reset();
      yield* tl;
    });
  }
}
