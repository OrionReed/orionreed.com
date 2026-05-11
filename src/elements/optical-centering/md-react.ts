// Reaction game. Targets blink in at random positions; the player has
// a short window to click each one. Each round is a `race(timeout,
// trackedClick)` — first to fire wins, the other gets cancelled. The
// outcome (hit vs miss) drives a different exit animation, and the
// loop continues.
//
// What this exercises:
//
//   • `race(...)` with mixed Yieldable — a number (timeout) and a
//     custom Awaitable (DOM click). Pick whichever; cancel the loser.
//   • A custom Awaitable that subscribes to a DOM event AND records
//     side-state on wake. Disposer removes the listener — including the
//     race-loser case where wake never fires.
//   • A multi-stage per-round pipeline (intro → race → outro) all in
//     one generator, reading top-to-bottom.
//   • A global STOP button that disposes the loop. Cascade kills the
//     in-flight round (any pending click listener is removed via the
//     awaitable's disposer; no leaks). RESET starts the loop again.
//   • `try { … } finally { target.dispose(); }` to keep the SVG clean
//     across rounds — runs on natural completion *and* on cancel.
//
// The deeper point: every "race against time or input" UX pattern is
// the same shape — `race(timeout, eventAwaitable)`. No bespoke
// scheduler, no AbortController, no useEffect cleanup juggling. The
// generator reads top-to-bottom; cancellation flows through the tree.

import {
  Diagram,
  Scene,
  align,
  bounceIn,
  button,
  circle,
  computed,
  css,
  fadeOut,
  label,
  pt,
  race,
  rect,
  signal,
  zoomOut,
  type Animator,
  type Awaitable,
  type Content,
  type Signal,
  type Writable,
} from "../../minim";

const W = 380;
const H = 260;
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

/** Custom Awaitable: wake on a DOM click AND record that the click
 *  fired (via `flag`). The disposer removes the listener regardless,
 *  so the race-loser case (timeout wins) doesn't leak. */
function trackedClick(target: EventTarget, flag: Signal<boolean>): Awaitable {
  return (wake) => {
    const handler = (): void => {
      flag.value = true;
      wake();
    };
    target.addEventListener("click", handler, { once: true });
    return () => target.removeEventListener("click", handler);
  };
}

export class MdReact extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 420px;
    }
  `;

  protected scene(s: Scene): void {
    s.view(0, 0, W, H);

    // Playfield rectangle — visual frame for the target spawn area.
    s(
      rect(PAD - 6, PAD - 6, W - 2 * (PAD - 6), PLAYFIELD_H - 2 * (PAD - 6) + 12, {
        thin: true,
        opacity: 0.2,
      }),
    );

    const hits = signal(0);
    const misses = signal(0);
    const status = signal<Content>("running");

    s(
      label(pt(PAD, STATS_Y), hits.derive((n) => `hits: ${n}`), {
        size: 12,
        align: align.left,
      }),
    );
    s(
      label(
        pt(W - PAD, STATS_Y),
        misses.derive((n) => `misses: ${n}`),
        { size: 12, align: align.right },
      ),
    );
    s(
      label(
        pt(W / 2, STATS_Y),
        computed(() => {
          const h = hits.value;
          const m = misses.value;
          const total = h + m;
          if (total === 0) return "—";
          return `${Math.round((h / total) * 100)}%`;
        }),
        { size: 12, align: align.center, opacity: 0.6 },
      ),
    );

    s(
      label(pt(W / 2, STATUS_Y), status, {
        size: 11,
        align: align.center,
        opacity: 0.5,
      }),
    );

    const anim = this.anim;
    let dispose: (() => void) | undefined;

    /** The spawned target must be both writable on the props the
     *  intro/outro animations touch, *and* a Shape (for `el` access by
     *  trackedClick + `dispose()` for end-of-round cleanup). The
     *  `circle(...)` factory satisfies all three. */
    type Target = Writable<"opacity" | "scale"> & {
      el: EventTarget;
      dispose(): void;
    };

    const spawnTarget = (): Target => {
      const x = PAD + Math.random() * (W - 2 * PAD);
      const y =
        PAD + Math.random() * (PLAYFIELD_H - 2 * PAD);
      return s(circle(pt(x, y), TARGET_R, { fill: true, opacity: 0 }));
    };

    function* round(target: Target): Animator {
      try {
        const clicked = signal(false);
        // The race: timeout (number) vs a tracked click (custom
        // awaitable). Whichever fires first wakes the parent and
        // cancels the loser (listener removed via dispose).
        yield race(ROUND_TIMEOUT, trackedClick(target.el, clicked));
        if (clicked.value) {
          hits.value = hits.peek() + 1;
          yield* zoomOut(target, 0.25);
        } else {
          misses.value = misses.peek() + 1;
          yield* fadeOut(target, 0.35);
        }
      } finally {
        // Runs on natural completion and on cancel. `dispose()` is
        // idempotent — safe even if the round was already in its
        // outro when STOP fired. Without this, the SVG would
        // accumulate invisible nodes across rounds.
        target.dispose();
      }
    }

    const startLoop = (): void => {
      hits.value = 0;
      misses.value = 0;
      status.value = "running";
      dispose = anim.loop(function* () {
        const target = spawnTarget();
        yield* bounceIn(target, 0.3);
        yield* round(target);
        yield RESPAWN;
      });
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
      button(pt(btnsX, BTN_Y), "STOP", onStop, { width: BTN_W, height: BTN_H }),
    );
    s(
      button(pt(btnsX + BTN_W + BTN_GAP, BTN_Y), "RESET", onReset, {
        width: BTN_W,
        height: BTN_H,
      }),
    );

    startLoop();
  }
}
