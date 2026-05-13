// Two cancellation modes. EXIT cooperatively flips a `stop` signal —
// each shape's `endOn(untilChange(stop), oscillate(...))` resumes,
// and the next statement (`fadeOut`) runs as the sequel in the same
// generator. STOP cancels via the run disposers — the cascade also
// kills any in-flight fadeOut (shapes freeze mid-fade).

import {
  Diagram,
  Mount,
  Anchor,
  button,
  cell,
  circle,
  endOn,
  fadeOut,
  label,
  oscillate,
  pt,
  untilChange,
  type Animator,
  type Cell,
  type Content,
  type Writable,
} from "../../minim";

const N = 12;
const SHAPE_Y = 40;
const STATUS_Y = 100;
const BTN_Y = 116;
const BTN_W = 80;
const BTN_H = 26;
const BTN_GAP = 12;

function* lifecycle(
  shape: Writable<"opacity">,
  y: Cell<number>,
  amp: number,
  freq: number,
  stop: Cell<boolean>,
): Animator {
  yield endOn(untilChange(stop), oscillate(y, amp, freq));
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
      y: Cell<number>;
      shape: Writable<"opacity">;
    };
    const slots: Slot[] = [];
    const stride = (view.w.value - 60) / (N - 1);
    for (let i = 0; i < N; i++) {
      const x = 30 + i * stride;
      const y = cell(SHAPE_Y);
      const shape = s(circle(pt(x, y), 8, { fill: true }));
      slots.push({ x, y, shape });
    }

    // Per-cycle stop signal + collected disposers. EXIT flips stop;
    // STOP calls every disposer.
    const anim = this.anim;
    let stop: Cell<boolean> = cell(false);
    let disposers: (() => void)[] = [];

    const startCycle = (): void => {
      for (const slot of slots) slot.shape.opacity.value = 1;
      for (const slot of slots) slot.y.value = SHAPE_Y;
      stop = cell(false);
      const localStop = stop;
      disposers = slots.map((slot, i) =>
        anim.run(() =>
          lifecycle(slot.shape, slot.y, 14, 0.45 + i * 0.04, localStop),
        ),
      );
      status.value = "running";
    };

    const onExit = (): void => {
      if (stop.peek()) return;
      stop.value = true;
      status.value = "exiting…";
      anim.run(function* () {
        yield 1.4;
        startCycle();
      });
    };

    const onStop = (): void => {
      for (const d of disposers) d();
      disposers = [];
      status.value = "stopped — restarting…";
      anim.run(function* () {
        yield 1.6;
        startCycle();
      });
    };

    const btnsW = BTN_W * 2 + BTN_GAP;
    const btnsX = view.center.x.value - btnsW / 2;
    s(
      button(pt(btnsX, BTN_Y), "EXIT", onExit, { width: BTN_W, height: BTN_H }),
      button(pt(btnsX + BTN_W + BTN_GAP, BTN_Y), "STOP", onStop, {
        width: BTN_W,
        height: BTN_H,
      }),
    );

    startCycle();
  }
}
