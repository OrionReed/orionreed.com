import {
  circle,
  Diagram,
  drag,
  drive,
  label,
  Mount,
  num,
  polar,
  signal,
  type Vec,
  vec,
  type Writable,
} from "../../minim";

const TAU = Math.PI * 2;

export class MdSolarSystem extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 360);

    // The whole solar system is deterministic in `time`. Each body's
    // angle is `time.affine(τ/period, phase)` — a single invertible op.
    // Polar with `"circular"` policy writes only to the angle, which
    // writes back through affine to time. So dragging ANY body scrubs
    // time; every other body recomputes. One scalar, every visual.
    const time = num(0);
    const dragging = signal(false);

    const sun = vec(view.center.value.x, view.center.value.y);

    /** A body orbiting `parent`, on its own circular orbit. */
    const orbit = (
      parent: Writable<Vec>,
      dist: number,
      period: number,
      phase: number,
      color: string,
      size: number,
    ) => {
      const angle = time.affine(TAU / period, phase);
      const pos = polar(parent, dist, angle, "circular");
      // Faint orbit ring.
      s(circle(parent, dist, { thin: true, dashed: true, opacity: 0.18 }));
      const body = s(circle(pos, size, { fill: color }));
      // Drag the body itself; no separate handle dot.
      drag(body, pos, dragging);
      return pos;
    };

    // Sun stays put (no drag target — it's the world origin).
    s(circle(sun, 14, { fill: true }));

    /* mercury */ orbit(sun, 50, 5, 0.0, "#f5a623", 4);
    /* venus   */ orbit(sun, 90, 9, 1.4, "#e25c5c", 6);
    const earth = orbit(sun, 140, 14, 2.7, "#5b8def", 7);
    /* moon    */ orbit(earth, 22, 3, 0.0, "#bbb", 3);

    // Run time forward. Pauses while any body is being dragged — the
    // drag IS the time-scrub.
    this.anim.start(
      drive(tick => {
        if (dragging.value) return;
        time.value = time.peek() + tick.dt;
      }),
    );

    s(
      label(view.top.down(20), "drag any planet or moon — the whole system winds/unwinds in time"),
      label(
        view.bottom.up(16),
        "one `time: Num` · every body angle = time.affine(τ/period, phase) · circular polar",
        { size: 10 },
      ),
    );
  }
}
