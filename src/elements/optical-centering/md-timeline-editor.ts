// Mini timeline editor: editable named durations driving a looping
// animation. Demonstrates the full Step 8/9/10 stack:
//
//   - `timeline({...})` for named, edit-friendly duration signals
//   - `during(tl[name], fn)` time-blocks parameterized by signal duration
//   - `shape.on("pointer*", ...)` for drag-to-edit knobs
//   - `shape.toLocal(evt)` to convert pointer events to scene coords
//   - `anim.emit/on/until` for click pings + reactive tap counts
//   - `function* (a)` runner-receives-anim form
//
// Drag the knobs below the timeline strip to retime each phase live.
// Click any of the stage actors to ping (counter increments). The
// loop's `during` blocks re-read `tl[name].value` every frame, so
// retiming a phase mid-block stretches/shrinks t accordingly.

import {
  Diagram,
  Scene,
  align,
  circle,
  computed,
  css,
  during,
  label,
  line,
  pt,
  rect,
  signal,
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
    const tl = timeline({ intro: 0.7, hold: 1.2, outro: 0.5 });
    const total = computed(() =>
      tl.intro.value + tl.hold.value + tl.outro.value,
    );
    // Cumulative offset signals — one per phase, summing prior phases.
    const offsets = {
      intro: computed(() => 0),
      hold: computed(() => tl.intro.value),
      outro: computed(() => tl.intro.value + tl.hold.value),
    };

    // Reactive playhead + tap counter.
    const phase = signal<string>(PHASES[0]);
    const phaseT = signal(0);
    const taps = signal(0);
    this.anim.on("ping", () => {
      taps.value = taps.peek() + 1;
    });

    // ── Header ────────────────────────────────────────────────────────
    s(label(
      pt(W / 2, 24),
      computed(
        () => `phase: ${phase.value}   ·   taps: ${taps.value}`,
      ),
      { size: 14, opacity: 0.75 },
    ));

    // ── Timeline strip (top) ──────────────────────────────────────────
    const STRIP_X = 60;
    const STRIP_W = W - 120;
    const STRIP_Y = 60;
    const STRIP_H = 36;
    const scale = computed(() => STRIP_W / total.value);

    PHASES.forEach((name, i) => {
      const x = computed(() => STRIP_X + offsets[name].value * scale.value);
      const w = computed(() => tl[name].value * scale.value);
      s(rect(x, STRIP_Y, w, STRIP_H, { fill: COLORS[i] }));
      s(label(
        pt(
          computed(() => STRIP_X + (offsets[name].value + tl[name].value / 2) * scale.value),
          STRIP_Y + 18,
        ),
        computed(() => `${name} ${tl[name].value.toFixed(2)}s`),
        { size: 11, opacity: 0.95 },
      ));
    });

    // Playhead — vertical line at (cumulative offset of active phase) +
    // (phaseT * its duration), all reactive.
    const playX = computed(() => {
      const name = phase.value as keyof typeof tl;
      const off = offsets[name]?.value ?? 0;
      const dur = tl[name]?.value ?? 1;
      return STRIP_X + (off + phaseT.value * dur) * scale.value;
    });
    s(line(
      pt(playX, STRIP_Y - 6),
      pt(playX, STRIP_Y + STRIP_H + 6),
      { strokeWidth: 2 },
    ));

    // ── Slider knobs (middle) ─────────────────────────────────────────
    const SLIDER_Y = 150;
    const SLIDER_GAP = 24;
    const SLIDER_W = (W - 120 - SLIDER_GAP * 2) / 3;

    PHASES.forEach((name, i) => {
      const x0 = 60 + i * (SLIDER_W + SLIDER_GAP);
      const x1 = x0 + SLIDER_W;
      const sig = tl[name];

      const track = s(line(
        pt(x0, SLIDER_Y),
        pt(x1, SLIDER_Y),
        { thin: true, opacity: 0.3, cap: "round" },
      ));

      // Knob position is computed from the duration; user drags to write.
      const knob = circle(pt(0, 0), 9, {
        fill: COLORS[i],
        translate: computed(() => ({
          x: x0 + (sig.value / MAX_DUR) * SLIDER_W,
          y: SLIDER_Y,
        })),
      });

      let dragging = false;
      knob.on("pointerdown", (e) => {
        const ev = e as PointerEvent;
        dragging = true;
        knob.el.setPointerCapture(ev.pointerId);
      });
      knob.on("pointermove", (e) => {
        if (!dragging) return;
        const local = track.toLocal(e as PointerEvent);
        const u = Math.min(Math.max((local.x - x0) / SLIDER_W, 0), 1);
        // Floor at 0.1s so a phase never reaches zero (would freeze the loop).
        sig.value = Math.max(0.1, u * MAX_DUR);
      });
      const stop = () => { dragging = false; };
      knob.on("pointerup", stop);
      knob.on("pointercancel", stop);
      s(knob);
    });

    // ── Stage actors (bottom) — one per phase, clickable for "ping" ──
    const STAGE_Y = 240;
    const actors = PHASES.map((_, i) => {
      const c = circle(pt(120 + i * 180, STAGE_Y), 24, {
        fill: COLORS[i],
        opacity: 0.25,
      });
      c.on("click", () => this.anim.emit("ping"));
      return c;
    });
    actors.forEach((c) => s(c));

    s(label(
      pt(W / 2, H - 16),
      "drag the knobs to retime · click any circle to ping",
      { size: 11, opacity: 0.5, align: align.center },
    ));

    // ── Animation flow: loop through phases reactively ───────────────
    this.anim.loop(function* () {
      for (let i = 0; i < PHASES.length; i++) {
        const name = PHASES[i];
        phase.value = name;
        // `during(tl[name], fn)` re-reads the duration every frame, so
        // dragging the knob mid-phase lengthens or shortens it live.
        yield* during(tl[name], (t) => {
          phaseT.value = t;
          actors[i].opacity.value = 0.25 + t * 0.75;
        });
        actors[i].opacity.value = 0.25;
      }
    });
  }
}
