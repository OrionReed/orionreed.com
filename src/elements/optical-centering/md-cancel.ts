// Two cancellation modes. EXIT cooperatively flips a `stop` signal —
// each shape's `endOn(untilChange(stop), oscillate(...))` resumes,
// and the next statement (`fadeOut`) runs as the sequel in the same
// generator. STOP cancels via the run disposers — the cascade also
// kills any in-flight fadeOut (shapes freeze mid-fade).

import {
  Diagram,
  Scene,
  Anchor,
  button,
  circle,
  css,
  endOn,
  fadeOut,
  label,
  oscillate,
  pt,
  signal,
  untilChange,
  type Animator,
  type Content,
  type Signal,
  type Writable,
} from "../../minim";

const W = 380;
const H = 160;
const N = 12;
const SHAPE_Y = 40;
const STATUS_Y = 100;
const BTN_Y = 116;
const BTN_W = 80;
const BTN_H = 26;
const BTN_GAP = 12;

function* lifecycle(
  shape: Writable<"opacity">,
  y: Signal<number>,
  amp: number,
  freq: number,
  stop: Signal<boolean>,
): Animator {
  yield endOn(untilChange(stop), oscillate(y, amp, freq));
  yield* fadeOut(shape, 0.4);
}

export class MdCancel extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 420px;
    }
  `;

  protected scene(s: Scene): void {
    s.view(W, H);

    const status = signal<Content>("running");
    s(
      label(pt(W / 2, STATUS_Y), status, {
        size: 11,
        align: Anchor.Center,
        opacity: 0.55,
      }),
    );

    type Slot = {
      x: number;
      y: Signal<number>;
      shape: Writable<"opacity">;
    };
    const slots: Slot[] = [];
    for (let i = 0; i < N; i++) {
      const x = 30 + i * ((W - 60) / (N - 1));
      const y = signal(SHAPE_Y);
      const shape = s(circle(pt(x, y), 8, { fill: true }));
      slots.push({ x, y, shape });
    }

    // Per-cycle stop signal + collected disposers. EXIT flips stop;
    // STOP calls every disposer.
    const anim = this.anim;
    let stop: Signal<boolean> = signal(false);
    let disposers: (() => void)[] = [];

    const startCycle = (): void => {
      for (const slot of slots) slot.shape.opacity.value = 1;
      for (const slot of slots) slot.y.value = SHAPE_Y;
      stop = signal(false);
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
    const btnsX = (W - btnsW) / 2;
    s(button(pt(btnsX, BTN_Y), "EXIT", onExit, { width: BTN_W, height: BTN_H }));
    s(
      button(pt(btnsX + BTN_W + BTN_GAP, BTN_Y), "STOP", onStop, {
        width: BTN_W,
        height: BTN_H,
      }),
    );

    startCycle();
  }
}
