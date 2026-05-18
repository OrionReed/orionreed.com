// Spring tracking + nested time-scales.
//
// A black dashed target outline tweens to a new random pose every few
// seconds, then STOPS — a discrete sequence of jump + dwell. Its
// motion loop runs at engine root (no `.at()`), outside any scaled
// subtree, so it keeps stepping even when master = 0.
//
// A single colored follower spring-tracks the target's full Transform
// — translate + rotate + scale spring simultaneously, because
// Transform carries LINEAR + METRIC traits. Tuned bouncy.
//
// A MASTER scale oscillates between 0 and 2× over the demo. The
// follower's spring runs under `play(spring(…)).at(() => master)`.
// When master = 0 the engine skips the spring's active entirely (no
// gen.next() calls) — the follower truly freezes, mid-bounce, while
// the target's next jump tween still proceeds at engine time.
//
// That "frozen follower + a target that keeps moving on its own
// schedule" contrast is what only engine-level time-scale can
// produce. Shortening tween durations couldn't get you here.

import {
  Anchor, Diagram, Mount, easeInOut,
  label, loop, num, play, rect, spring, tween, vec,
} from "../../minim";

const VIEW_W = 680;
const VIEW_H = 360;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2 - 16;

const POSE_DX = 120;
const POSE_DY = 70;

function randomPose() {
  return {
    translate: {
      x: CX + (-POSE_DX + Math.random() * 2 * POSE_DX),
      y: CY + (-POSE_DY + Math.random() * 2 * POSE_DY),
    },
    scale: {
      x: 0.75 + Math.random() * 0.6,
      y: 0.75 + Math.random() * 0.6,
    },
    rotate: -0.7 + Math.random() * 1.4,
    origin: { x: 0, y: 0 },
    opacity: 1,
  };
}

const INITIAL_POSE = {
  translate: { x: CX, y: CY },
  scale: { x: 1, y: 1 },
  rotate: 0,
  origin: { x: 0, y: 0 },
  opacity: 1,
};

export class MdTrails extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(VIEW_W, VIEW_H);

    // Target — dashed black outline, no fill. Normal stroke weight
    // (not thin). Drawn first so the follower lands on top.
    const target = s(rect(-55, -35, 110, 70, {
      fill: "transparent",
      stroke: "#1a1a1a",
      dashed: true,
      corner: 8,
    }));
    target.transform.value = INITIAL_POSE;

    // Master scale — animated by the loop below.
    const master = num(1);

    // Follower — single blue rect that spring-tracks the target.
    // Tuned BOUNCY (low damping ratio) so the user sees pronounced
    // overshoot when the target jumps.
    const follower = s(rect(-55, -35, 110, 70, {
      fill: "#5b8def",
      opacity: 0.7,
      corner: 8,
      aside: true,
    }));
    follower.transform.value = INITIAL_POSE;

    this.anim.start(function* () {
      yield* play(spring(follower.transform, target.transform, {
        stiffness: 120,
        damping: 9,     // ratio ≈ 0.41 — visibly bouncy
        precision: 0,   // never settle; live tracking
      })).at(() => master.value);
    });

    // ── Target motion: tween-then-stop loop ─────────────────────────
    // Jump to a new random pose every ~3.5s. Engine root (no `.at()`)
    // — keeps firing while master = 0 so the follower's freeze is
    // visible against a target that JUST jumped without it.
    this.anim.start(loop(function* () {
      yield* tween(target.transform, randomPose(), 0.9, easeInOut);
      yield 2.6;  // dwell before the next jump
    }));

    // ── Master scale loop ───────────────────────────────────────────
    // 1 → 2 → 1 → 0 (long dwell) → 1. Engine time.
    this.anim.start(loop(function* () {
      yield* tween(master, 2, 1.2, easeInOut);
      yield 0.7;
      yield* tween(master, 1, 1.0, easeInOut);
      yield 0.5;
      yield* tween(master, 0, 1.4, easeInOut);
      yield 3.2;  // long dwell: see the follower stranded as target jumps
      yield* tween(master, 1, 1.2, easeInOut);
      yield 0.5;
    }));

    // ── Master indicator bar (bottom) ───────────────────────────────
    const BAR_X0 = 110;
    const BAR_W  = VIEW_W - 220;
    const BAR_Y  = VIEW_H - 38;

    s(rect(BAR_X0, BAR_Y - 1, BAR_W, 2, {
      fill: "rgba(127,127,127,0.3)",
      stroke: "transparent",
      aside: true,
    }));

    const fillColor = () => {
      const v = master.value;
      if (v < 0.06) return "#e25c5c";  // red: paused
      if (v < 0.9)  return "#f5a623";  // orange: slow
      if (v < 1.1)  return "#10b981";  // green: normal
      return "#5b8def";                // blue: fast
    };
    s(rect(
      BAR_X0, BAR_Y - 4,
      () => Math.min(BAR_W, (master.value / 2.5) * BAR_W),
      8,
      { fill: fillColor, stroke: "transparent", corner: 4, aside: true },
    ));

    s(label(
      vec(BAR_X0 + BAR_W + 14, BAR_Y + 4),
      () => `${master.value.toFixed(2)}×`,
      { size: 11, align: Anchor.Left, opacity: 0.7 },
    ));
    s(label(
      vec(BAR_X0 - 14, BAR_Y + 4),
      "master",
      { size: 11, align: Anchor.Right, opacity: 0.55 },
    ));

    // ── Title labels ────────────────────────────────────────────────
    s(
      label(view.top.down(22),
        "the dashed target jumps to random poses · the follower spring-tracks it",
        { size: 12, align: Anchor.Center, opacity: 0.7 }),
      label(view.top.down(40),
        "master = 0 → follower freezes (engine skips its active) · target keeps jumping",
        { size: 10, align: Anchor.Center, opacity: 0.5 }),
    );
  }
}
