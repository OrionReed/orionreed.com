import {
  type Animator,
  button,
  type Content,
  cell,
  circle,
  Diagram,
  fadeOut,
  type Has,
  label,
  loop,
  type Mount,
  type Num,
  num,
  play,
  vec,
  type Writable,
  wave,
} from "../../minim";

/** Sine oscillation around `sig`'s start value. */
const oscillate = (sig: Writable<Num>, amp: number, freq: number) =>
  wave(sig, (t, base) => base + amp * Math.sin(2 * Math.PI * freq * t));

const N_SLOTS = 12;
const SHAPE_Y = 40;
const STATUS_Y = 100;
const BTN_Y = 116;
const BTN_W = 80;
const BTN_H = 26;
const BTN_GAP = 12;

export class MdCancel extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(380, 160);

    const status = cell<Content>("running");
    s(label(view.top.down(STATUS_Y), status));

    type Slot = {
      x: number;
      // `Writable<Num>` — oscillate writes through its value.
      y: Writable<Num>;
      shape: Has<"opacity">;
    };
    const slots: Slot[] = [];
    const stride = (view.w.value - 60) / (N_SLOTS - 1);
    for (let i = 0; i < N_SLOTS; i++) {
      const x = 30 + i * stride;
      const y = num(SHAPE_Y);
      const shape = s(circle(vec(x, y), 8, { fill: true }));
      slots.push({ x, y, shape });
    }

    const stop = cell(false);
    const hardStop = cell(false);

    s(
      button(
        vec(view.center.x.value - BTN_W - BTN_GAP / 2, BTN_Y),
        "EXIT",
        () => {
          if (!stop.peek() && !hardStop.peek()) {
            stop.value = true;
            status.value = "exiting…";
          }
        },
        { width: BTN_W, height: BTN_H },
      ),
      button(
        vec(view.center.x.value + BTN_GAP / 2, BTN_Y),
        "STOP",
        () => {
          if (!hardStop.peek()) {
            hardStop.value = true;
            status.value = "stopped — restarting…";
          }
        },
        { width: BTN_W, height: BTN_H },
      ),
    );

    this.anim.start(
      loop(function* () {
        for (const slot of slots) slot.shape.opacity.value = 1;
        for (const slot of slots) slot.y.value = SHAPE_Y;
        stop.value = false;
        hardStop.value = false;
        status.value = "running";

        // Each slot oscillates until `stop`, then fades out. The outer
        // `.until(hardStop)` interrupts the whole group on the hard exit.
        const lifecycles: Animator[] = slots.map((slot, i) =>
          (function* (): Animator {
            yield* play(oscillate(slot.y, 14, 0.45 + i * 0.04)).until(stop);
            yield fadeOut(slot.shape, 0.4);
          })(),
        );
        yield* play(lifecycles).until(hardStop);

        yield hardStop.peek() ? 1.6 : 1.4;
      }),
    );
  }
}
