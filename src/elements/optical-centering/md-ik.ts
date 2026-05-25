import {
  Anchor,
  argminVec,
  circle,
  clampToDisc,
  Diagram,
  drag,
  label,
  line,
  Mount,
  type Num,
  num,
  Vec,
  vec,
  type Writable,
} from "../../minim";

const N = 5;
const L = 56;

export class MdIk extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 360);

    const root = vec(view.left.right(80).value.x, view.center.value.y);

    // Slight initial bend so the Jacobian isn't singular at start.
    const angles = Array.from({ length: N }, () => num(0.1));

    // Joint positions for rendering.
    const joints: Vec[] = [root];
    for (let i = 0; i < N; i++) {
      const segIdx = i;
      const prev = joints[i];
      joints.push(
        Vec.derive(() => {
          let sumA = 0;
          for (let k = 0; k <= segIdx; k++) sumA += angles[k].value;
          return {
            x: prev.value.x + L * Math.cos(sumA),
            y: prev.value.y + L * Math.sin(sumA),
          };
        }),
      );
    }

    // Workspace is the disc of radius N·L around `root`. Clamp the
    // requested target into the disc BEFORE the Newton step, so the
    // IK never tries to invert through the rank-deficient regime at
    // full extension. The arm reaches the boundary cleanly and stops.
    const tip = argminVec(
      angles as unknown as readonly Writable<Num>[],
      ts => {
        let x = root.value.x;
        let y = root.value.y;
        let sumA = 0;
        for (const t of ts) {
          sumA += t;
          x += L * Math.cos(sumA);
          y += L * Math.sin(sumA);
        }
        return { x, y };
      },
      angles.map(() => 1),
      { clampTarget: clampToDisc(root.value, N * L - 0.5) },
    );

    for (let i = 0; i < N; i++) {
      s(line(joints[i], joints[i + 1], { thin: false }));
      if (i > 0) s(circle(joints[i], 4, { fill: "var(--bg-color, white)", thin: true }));
    }
    s(circle(root, 6, { fill: true }));
    const tipDot = s(circle(tip, 8, { fill: "#5b8def" }));
    drag(tipDot, tip);
    tipDot.el.style.cursor = "grab";

    s(
      label(view.top.down(20), "drag the blue tip — workspace clamp keeps IK stable at max reach", {
        size: 12,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(16),
        "argminVec(angles, fwd, weights, { clampTarget: clampToDisc(root, N·L) })",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }
}
