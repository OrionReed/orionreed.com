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

    const target = s(rect(-55, -35, 110, 70, {
      fill: "transparent",
      stroke: "#1a1a1a",
      dashed: true,
      corner: 8,
    }));
    target.transform.value = INITIAL_POSE;

    const master = num(1);

    const follower = s(rect(-55, -35, 110, 70, {
      fill: "#5b8def",
      opacity: 0.7,
      corner: 8,
      aside: true,
    }));
    follower.transform.value = INITIAL_POSE;

    this.anim.start(function* () {
      yield* play(spring(follower.transform, target.transform, {
        omega: 11,
        zeta: 0.4,
        precision: 0,
      })).at(() => master.value);
    });

    // Engine root (no `.at()`) so it keeps stepping while master = 0.
    this.anim.start(loop(function* () {
      yield* tween(target.transform, randomPose(), 0.9, easeInOut);
      yield 2.6;
    }));

    this.anim.start(loop(function* () {
      yield* tween(master, 2, 1.2, easeInOut);
      yield 0.7;
      yield* tween(master, 1, 1.0, easeInOut);
      yield 0.5;
      yield* tween(master, 0, 1.4, easeInOut);
      yield 3.2;
      yield* tween(master, 1, 1.2, easeInOut);
      yield 0.5;
    }));

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
      if (v < 0.06) return "#e25c5c";
      if (v < 0.9)  return "#f5a623";
      if (v < 1.1)  return "#10b981";
      return "#5b8def";
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
