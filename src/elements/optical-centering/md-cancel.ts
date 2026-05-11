// Two cancellation modes side by side. EXIT cooperatively shuts the
// behaviors down and lets each shape animate out via its own sequel;
// STOP cancels everything via the disposer (cascading through any
// in-flight exits too).
//
// The pattern: each shape's lifecycle is one generator —
//
//     yield until(untilChange(stop), oscillate(...));
//     yield* fadeOut(s, 0.4);
//
// `until(trigger, work)` runs the work as a child; when `trigger`
// fires, the child is cancelled and the awaitable resumes. The next
// `yield*` is the exit, and it runs in the *same* generator. No host
// reference, no try/finally, no separate registry. Cancellation is
// just race(work, trigger), named for the intent.
//
// STOP demonstrates that hard cancel reaches everything, including
// exits-in-flight: click STOP while shapes are fading and they freeze
// mid-fade. The structural cascade is the same machinery throughout.

import {
  Diagram,
  Scene,
  align,
  button,
  circle,
  css,
  fadeOut,
  label,
  oscillate,
  pt,
  signal,
  until,
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
  yield until(untilChange(stop), oscillate(y, amp, freq));
  yield* fadeOut(shape, 0.4);
}

export class MdCancel extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 420px;
    }
  `;

  protected scene(s: Scene): void {
    s.view(0, 0, W, H);

    const status = signal<Content>("running");
    s(
      label(pt(W / 2, STATUS_Y), status, {
        size: 11,
        align: align.center,
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

    // Controller: per-cycle stop signal + collected disposers. EXIT
    // flips stop (sequels run); STOP calls each disposer (cascade
    // catches anything in flight, including the sequels themselves).
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
