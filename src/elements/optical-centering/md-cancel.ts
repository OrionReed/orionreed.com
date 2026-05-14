// Two cancellation modes.
//
//   EXIT — cooperative: flip the `stop` signal; each lifecycle's
//          `oscillate(...).until(stop)` resolves, and `fadeOut` runs
//          as the sequel in the same generator.
//
//   STOP — hard cancel: flip `hardStop`; the loop's outer scope
//          (`parallel(lifecycles).until(hardStop)`) tears the entire
//          subtree down, mid-fade if necessary.
//
// No `disposers[]` array, no `anim.run()` from button callbacks. Both
// modes are signal-coordinated — buttons set signals, generators react
// via the standard fluent vocabulary.

import {
  Diagram,
  Mount,
  Anchor,
  button,
  cell,
  chain,
  circle,
  fadeOut,
  label,
  loop,
  num,
  oscillate,
  parallel,
  vec,
  type Animator,
  type Cell,
  type Content,
  type N,
  type Writable,
} from "../../minim";

const N_SLOTS = 12;
const SHAPE_Y = 40;
const STATUS_Y = 100;
const BTN_Y = 116;
const BTN_W = 80;
const BTN_H = 26;
const BTN_GAP = 12;

function* lifecycle(
  shape: Writable<"opacity">,
  y: N,
  amp: number,
  freq: number,
  stop: Cell<boolean>,
): Animator {
  yield* chain(oscillate(y, amp, freq)).until(stop);
  yield* fadeOut(shape, 0.4);
}

export class MdCancel extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(380, 160);

    const status = cell<Content>("running");
    s(
      label(view.top.down(STATUS_Y), status, {
        size: 11,
        align: Anchor.Center,
        opacity: 0.55,
      }),
    );

    type Slot = {
      x: number;
      // `y` is a `Num.signal` (rather than plain `cell(...)`) so the
      // oscillate integrator can read its `[ALGEBRA]` slot.
      y: N;
      shape: Writable<"opacity">;
    };
    const slots: Slot[] = [];
    const stride = (view.w.value - 60) / (N_SLOTS - 1);
    for (let i = 0; i < N_SLOTS; i++) {
      const x = 30 + i * stride;
      const y = num(SHAPE_Y);
      const shape = s(circle(vec(x, y), 8, { fill: true }));
      slots.push({ x, y, shape });
    }

    // Two signals coordinate the outer loop. Buttons set them; the
    // generator observes via `untilChange` / `untilTrue`.
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

    // One outer loop. Each iteration:
    //   1. Reset slots + signals.
    //   2. Run all N lifecycles in parallel, with `.until(hardStop)`
    //      wrapping the whole subtree — hardStop cascades cancellation
    //      to every child instantly.
    //   3. Decide post-cycle delay based on which signal fired.
    //   4. Loop restarts; everything fresh.
    this.anim.run(
      loop(function* () {
        for (const slot of slots) slot.shape.opacity.value = 1;
        for (const slot of slots) slot.y.value = SHAPE_Y;
        stop.value = false;
        hardStop.value = false;
        status.value = "running";

        yield* parallel(
          ...slots.map((slot, i) =>
            lifecycle(slot.shape, slot.y, 14, 0.45 + i * 0.04, stop),
          ),
        ).until(hardStop);

        yield hardStop.peek() ? 1.6 : 1.4;
      }),
    );
  }
}
