// Reaction game. Each round is `race(timeout, trackedClick)` — hit
// runs `zoomOut`, miss runs `fadeOut`. STOP cancels the loop; the
// cascade kills any in-flight click listener via its awaitable
// disposer.

import {
  Diagram,
  Mount,
  Anchor,
  bounceIn,
  button,
  cell,
  circle,
  fadeOut,
  label,
  loop,
  vec,
  race,
  rect,
  suspend,
  zoomOut,
  type Animator,
  type Content,
  type Writable,
} from "../../minim";

const W = 380;
const TARGET_R = 14;
const ROUND_TIMEOUT = 1.2;
const RESPAWN = 0.4;
const PAD = 30;
const PLAYFIELD_H = 160;
const STATS_Y = PLAYFIELD_H + 24;
const STATUS_Y = PLAYFIELD_H + 44;
const BTN_Y = PLAYFIELD_H + 60;
const BTN_W = 80;
const BTN_H = 26;
const BTN_GAP = 12;

/** Wake on a click; resume with the `MouseEvent`. Race winners get
 *  this payload; race losers (timeout) get `undefined` — the
 *  discriminator for hit vs miss in the round. */
function trackedClick(target: EventTarget): Animator<MouseEvent> {
  return suspend<MouseEvent>((wake) => {
    const handler = (e: Event): void => wake(e as MouseEvent);
    target.addEventListener("click", handler, { once: true });
    return () => target.removeEventListener("click", handler);
  });
}

export class MdReact extends Diagram {
  protected scene(s: Mount): void {
    this.view(W, 260);

    s(
      rect(PAD - 6, PAD - 6, W - 2 * (PAD - 6), PLAYFIELD_H - 2 * (PAD - 6) + 12, {
        thin: true,
        opacity: 0.2,
      }),
    );

    const hits = cell(0);
    const misses = cell(0);
    const status = cell<Content>("running");

    s(
      label(vec(PAD, STATS_Y), hits.derive((n) => `hits: ${n}`), {
        size: 12,
        align: Anchor.Left,
      }),
      label(
        vec(W - PAD, STATS_Y),
        misses.derive((n) => `misses: ${n}`),
        { size: 12, align: Anchor.Right },
      ),
      label(
        vec(W / 2, STATS_Y),
        cell.derived(() => {
          const h = hits.value;
          const m = misses.value;
          const total = h + m;
          if (total === 0) return "—";
          return `${Math.round((h / total) * 100)}%`;
        }),
        { size: 12, align: Anchor.Center, opacity: 0.6 },
      ),
      label(vec(W / 2, STATUS_Y), status, {
        size: 11,
        align: Anchor.Center,
        opacity: 0.5,
      }),
    );

    const anim = this.anim;
    let dispose: (() => void) | undefined;

    /** Target needs writable opacity/scale (for intro/outro) plus
     *  `el` (for trackedClick) plus `dispose()` (for round cleanup).
     *  `circle(...)` satisfies all three. */
    type Target = Writable<"opacity" | "scale"> & {
      el: EventTarget;
      dispose(): void;
    };

    const spawnTarget = (): Target => {
      const x = PAD + Math.random() * (W - 2 * PAD);
      const y =
        PAD + Math.random() * (PLAYFIELD_H - 2 * PAD);
      return s(circle(vec(x, y), TARGET_R, { fill: true, opacity: 0 }));
    };

    function* round(target: Target): Animator {
      try {
        // `yield* race(...)` resolves to the winner's payload — a
        // `MouseEvent` if the click landed, `undefined` if the timeout
        // ran out. The discriminator IS the payload; no flag needed.
        const evt = yield* race(ROUND_TIMEOUT, trackedClick(target.el));
        if (evt) {
          hits.value = hits.peek() + 1;
          yield* zoomOut(target, 0.25);
        } else {
          misses.value = misses.peek() + 1;
          yield* fadeOut(target, 0.35);
        }
      } finally {
        // Runs on natural completion AND cancel — without this, SVG
        // nodes would accumulate across rounds.
        target.dispose();
      }
    }

    const startLoop = (): void => {
      hits.value = 0;
      misses.value = 0;
      status.value = "running";
      dispose = anim.run(loop(function* () {
        const target = spawnTarget();
        yield* bounceIn(target, 0.3);
        yield* round(target);
        yield RESPAWN;
      }));
    };

    const onStop = (): void => {
      if (!dispose) return;
      dispose();
      dispose = undefined;
      status.value = "stopped";
    };

    const onReset = (): void => {
      if (dispose) dispose();
      startLoop();
    };

    const btnsW = BTN_W * 2 + BTN_GAP;
    const btnsX = (W - btnsW) / 2;
    s(
      button(vec(btnsX, BTN_Y), "STOP", onStop, { width: BTN_W, height: BTN_H }),
      button(vec(btnsX + BTN_W + BTN_GAP, BTN_Y), "RESET", onReset, {
        width: BTN_W,
        height: BTN_H,
      }),
    );

    startLoop();
  }
}
