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
const H = 110;
const N = 12;

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
    .controls {
      display: flex;
      justify-content: center;
      gap: 8px;
      padding: 0 0 14px;
    }
    button {
      font: 11px / 1 ui-monospace, monospace;
      letter-spacing: 0.05em;
      padding: 6px 14px;
      border: 1px solid var(--text-color);
      background: transparent;
      color: var(--text-color);
      cursor: pointer;
      border-radius: 3px;
      transition: background 0.15s ease, color 0.15s ease;
    }
    button:hover {
      background: var(--text-color);
      color: var(--bg-color);
    }
    button:active {
      transform: translateY(1px);
    }
  `;

  protected scene(s: Scene): void {
    s.view(0, 0, W, H);

    const status = signal<Content>("running");
    s(
      label(pt(W / 2, H - 14), status, {
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
      const y = signal(H / 2 - 20);
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
      for (const slot of slots) slot.y.value = H / 2 - 20;
      stop = signal(false);
      const localStop = stop;
      disposers = slots.map((slot, i) =>
        anim.run(() =>
          lifecycle(slot.shape, slot.y, 22, 0.45 + i * 0.04, localStop),
        ),
      );
      status.value = "running";
    };

    const exitBtn = document.createElement("button");
    exitBtn.textContent = "EXIT";
    exitBtn.onclick = (): void => {
      if (stop.peek()) return;
      stop.value = true;
      status.value = "exiting…";
      // After the longest fadeOut completes, restart so the demo
      // replays. Race the fade window against a hard cap.
      anim.run(function* () {
        yield 1.4;
        startCycle();
      });
    };

    const stopBtn = document.createElement("button");
    stopBtn.textContent = "STOP";
    stopBtn.onclick = (): void => {
      for (const d of disposers) d();
      disposers = [];
      status.value = "stopped — restarting…";
      anim.run(function* () {
        yield 1.6;
        startCycle();
      });
    };

    const controls = document.createElement("div");
    controls.className = "controls";
    controls.appendChild(exitBtn);
    controls.appendChild(stopBtn);
    this.shadow.appendChild(controls);

    startCycle();
  }
}
