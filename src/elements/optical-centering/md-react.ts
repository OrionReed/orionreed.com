// Reaction game. Targets blink in at random positions; the player has
// a short window to click each one. Each round is one yield-array of
// `race(timeout, trackedClick)` — first to fire wins, the other gets
// cancelled. The outcome (hit vs miss) drives a different exit
// animation, and the loop continues.
//
// What this exercises:
//
//   • `race(...)` with mixed Yieldable — a number (1.2s timeout) and a
//     custom Awaitable (DOM click). Pick whichever; cancel the loser.
//   • A custom Awaitable that subscribes to a DOM event AND records
//     side-state on wake. Disposer removes the listener — including the
//     race-loser case where wake never fires.
//   • A multi-stage per-round pipeline (intro → race → outro) all in
//     one generator, reading top-to-bottom.
//   • A global STOP button that disposes the loop. Cascade kills the
//     in-flight round (any pending click listener is removed via the
//     awaitable's disposer; no leaks). RESET starts the loop again.
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
const H = 220;
const TARGET_R = 14;
const ROUND_TIMEOUT = 1.2;
const RESPAWN = 0.4;
const PAD = 30;

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

    // Playfield rectangle — visual frame for the target spawn area.
    s(
      rect(PAD - 6, PAD - 6, W - 2 * (PAD - 6), H - 80, {
        thin: true,
        opacity: 0.2,
      }),
    );

    const hits = signal(0);
    const misses = signal(0);
    const status = signal<Content>("running");

    s(
      label(pt(PAD, H - 36), hits.derive((n) => `hits: ${n}`), {
        size: 12,
        align: align.left,
      }),
    );
    s(
      label(
        pt(W - PAD, H - 36),
        misses.derive((n) => `misses: ${n}`),
        { size: 12, align: align.right },
      ),
    );
    s(
      label(
        pt(W / 2, H - 36),
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
      label(pt(W / 2, H - 14), status, {
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
      const y = PAD + Math.random() * (H - 80 - 2 * PAD);
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

    const stopBtn = document.createElement("button");
    stopBtn.textContent = "STOP";
    stopBtn.onclick = (): void => {
      if (!dispose) return;
      dispose();
      dispose = undefined;
      status.value = "stopped";
    };

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "RESET";
    resetBtn.onclick = (): void => {
      if (dispose) dispose();
      // Clear any leftover targets — fade them and forget.
      // (New shapes get spawned by the new loop; old ones tick to dust
      // via opacity reads, but they're not animated. A fresh scene
      // build via reconnection would be cleaner; for the demo, just
      // overwrite scoreboard and re-spawn.)
      startLoop();
    };

    const controls = document.createElement("div");
    controls.className = "controls";
    controls.appendChild(stopBtn);
    controls.appendChild(resetBtn);
    this.shadow.appendChild(controls);

    startLoop();
  }
}
