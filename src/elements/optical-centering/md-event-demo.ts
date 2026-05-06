// Showcase for steps 8/9/10: shape.on (DOM events), anim event bus,
// during(timeline-range), timeline() factory.
//
// Three actors fade in across three named phases. Each phase ends
// either when its duration elapses OR when the user clicks any actor
// (which emits "step"). The whole flow is one generator; durations
// come from a `timeline({...})` so each phase is a named, edit-friendly
// signal. A click counter demonstrates the parallel `on(name, fn)`
// callback path.

import {
  Diagram,
  Scene,
  align,
  circle,
  css,
  during,
  label,
  pt,
  race,
  signal,
  timeline,
} from "../../minim";

export class MdEventDemo extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected scene(s: Scene): void {
    const W = 600;
    const H = 240;
    s.view(0, 0, W, H);

    // ── Editable named durations. The phase order is the timeline's
    //    own key order — no need to re-list the names.
    const tl = timeline({ intro: 0.7, hold: 1.2, outro: 0.6 });
    const phases = Object.keys(tl) as Array<keyof typeof tl>;

    // ── Reactive labels ──────────────────────────────────────────────
    const phaseSig = signal<string>("idle");
    const taps = signal(0);

    // ── Actors: one per phase; click any to emit "step" ─────────────
    const actors = phases.map((_, i) =>
      s(circle(pt(140 + i * 160, H / 2), 30, { fill: true, opacity: 0 })),
    );
    actors.forEach((c) => c.on("click", () => this.anim.emit("step")));

    // Per-phase duration label below each actor.
    phases.forEach((name, i) =>
      s(
        label(
          pt(140 + i * 160, H / 2 + 56),
          () => `${name}: ${tl[name].value.toFixed(2)}s`,
          { size: 11, opacity: 0.6 },
        ),
      ),
    );

    // Status header + footer.
    s(
      label(
        pt(W / 2, 28),
        () => `phase: ${phaseSig.value}   ·   taps: ${taps.value}`,
        { size: 14, opacity: 0.75 },
      ),
    );
    s(
      label(pt(W / 2, H - 16), "click any circle to skip the current phase", {
        size: 11,
        opacity: 0.5,
        align: align.center,
      }),
    );

    // Parallel listener path — counts every "step" event.
    this.anim.on("step", () => {
      taps.value = taps.peek() + 1;
    });

    // ── Animation flow: events × ranges in one generator ────────────
    const anim = this.anim;
    anim.loop(function* () {
      for (let i = 0; i < phases.length; i++) {
        const name = phases[i];
        phaseSig.value = name;

        // race: phase finishes when EITHER its duration elapses OR
        // the user clicks (emits "step"). Either way, the next phase
        // takes over. No conditional branching — pure composition.
        yield* race(
          during(tl[name], (t) => {
            actors[i].opacity.value = Math.min(t * 1.6, 1);
          }),
          anim.until("step"),
        );

        // Snap to fully visible at phase end so a fast skip looks
        // intentional rather than mid-fade.
        actors[i].opacity.value = 1;
      }

      // Reset.
      phaseSig.value = "rest";
      yield* during(0.4, (t) => {
        for (const ac of actors) ac.opacity.value = 1 - t;
      });
    });
  }
}
