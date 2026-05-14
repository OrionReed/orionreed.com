// Editable named durations driving a looping animation. Drag the
// knobs to retime; clip durations ripple through to subsequent starts
// via `sequential`. Actor opacities are pure signal bindings on
// `clip.t`.

import { Diagram, EventBus, Mount, Anchor, cell, circle, derive, draggable, label, line, loop, vec, rect, sequential, snapshot, timeline } from "../../minim";

const PHASES = ["intro", "hold", "outro"] as const;
const COLORS = ["#5b8def", "#f5a623", "#e25c5c"];
const MAX_DUR = 2.5;

export class MdTimelineEditor extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 320);

    // ── Editable timeline ──────────────────────────────────────────
    const tl = timeline(sequential({ intro: 0.7, hold: 1.2, outro: 0.5 }));
    const reset = snapshot(tl.clock);

    const phaseName = cell.derived(() => {
      for (const name of PHASES) if (tl[name].active.value) return name;
      return tl.clock.value >= tl.duration.value ? "rest" : PHASES[0];
    });
    const bus = new EventBus();
    const taps = cell(0);
    bus.on("ping", () => {
      taps.value = taps.peek() + 1;
    });

    // ── Header ─────────────────────────────────────────────────────
    s(
      label(
        view.top.down(24),
        cell.derived(() => `phase: ${phaseName.value}   ·   taps: ${taps.value}`),
        { size: 14, opacity: 0.75 },
      ),
    );

    // ── Timeline strip (top) ───────────────────────────────────────
    const STRIP_X = 60;
    const STRIP_W = view.w.value - 120;
    const STRIP_Y = 60;
    const STRIP_H = 36;
    const scale = cell.derived(() => STRIP_W / tl.duration.value);

    PHASES.forEach((name, i) => {
      const c = tl[name];
      const body = s(
        rect(
          derive(c.at, (a) => STRIP_X + a * scale.value),
          STRIP_Y,
          derive(c.dur, (d) => d * scale.value),
          STRIP_H,
          { fill: COLORS[i] },
        ),
      );
      s(
        label(
          body.center,
          cell.derived(() => `${name} ${c.dur.value.toFixed(2)}s`),
          { size: 11, opacity: 0.95 },
        ),
      );
    });

    const playX = cell.derived(() => STRIP_X + tl.t.value * STRIP_W);
    s(
      line(vec(playX, STRIP_Y - 6), vec(playX, STRIP_Y + STRIP_H + 6), {
        strokeWidth: 2,
      }),
    );

    // ── Slider knobs ───────────────────────────────────────────────
    const SLIDER_Y = 150;
    const SLIDER_GAP = 24;
    const SLIDER_W = (view.w.value - 120 - SLIDER_GAP * 2) / 3;

    PHASES.forEach((name, i) => {
      const x0 = 60 + i * (SLIDER_W + SLIDER_GAP);
      const dur = tl[name].dur;

      s(
        line(vec(x0, SLIDER_Y), vec(x0 + SLIDER_W, SLIDER_Y), {
          thin: true,
          opacity: 0.3,
          cap: "round",
        }),
      );

      const knob = s(
        circle(
          vec(() => x0 + (dur.value / MAX_DUR) * SLIDER_W, SLIDER_Y),
          9,
          { fill: COLORS[i] },
        ),
      );
      draggable(knob, (local) => {
        const u = Math.min(Math.max((local.x - x0) / SLIDER_W, 0), 1);
        // Floor at 0.1s — a zero-duration phase would freeze the loop.
        dur.value = Math.max(0.1, u * MAX_DUR);
      });
    });

    // ── Stage actors ───────────────────────────────────────────────
    const STAGE_Y = 240;
    const actors = PHASES.map((name, i) => {
      const c = circle(vec(120 + i * 180, STAGE_Y), 24, {
        fill: COLORS[i],
        opacity: derive(tl[name].t, (t) => 0.1 + t * 0.9),
      });
      c.on("click", () => bus.emit("ping"));
      return c;
    });
    s(...actors);

    s(
      label(
        view.bottom.up(16),
        "drag the knobs to retime · click any circle to ping",
        { size: 11, opacity: 0.5, align: Anchor.Center },
      ),
    );

    this.anim.run(loop(function* () {
      reset();
      yield* tl;
    }));
  }
}
