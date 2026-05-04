import { easeInOut, easeOut } from "../anim";
import { css } from "../base-element";
import { Content, Padding, Scene, SceneSize, t, Text } from "../draw";
import { down, left, lerpPt, pt, type Point } from "../geom";
import { SceneElement } from "../scene-element";

// Local helpers — promote to lib only if a third diagram needs them.

interface Segment {
  from: Point;
  to: Point;
  at(f: number): Point;
}

function seg(from: Point, to: Point): Segment {
  return { from, to, at: (f) => lerpPt(from, to, f) };
}

// Endpoints of a perpendicular tick of `2 * half` length at fraction `f`
// along `s`. Tick orientation tracks the segment's current direction.
function tickAt(s: Segment, f: number, half: number): [Point, Point] {
  const dx = s.to.x - s.from.x;
  const dy = s.to.y - s.from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  const c = s.at(f);
  return [pt(c.x - nx, c.y - ny), pt(c.x + nx, c.y + ny)];
}

function math(base: string, sub?: string): Text {
  const b = t(base).italic();
  return sub ? b.sub(t(sub).italic()) : b;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const INITIAL = {
  lineT: 0,
  labelsO: 0,
  morphT: 0,
  yLabelsO: 0,
  boxO: 0,
  centroidO: 0,
};

export class MdCentering extends SceneElement {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  // Origin near the bottom-left so the duplicate has somewhere to sweep
  // up into. Marks at F.min/F.max are interpolations of the line, not
  // its endpoints; F.mid is their midpoint.
  private O = pt(60, 170);
  private xEnd = pt(570, 170);
  private yEnd = pt(60, 30);
  private F = { min: 0.2, mid: 0.45, max: 0.7 };

  private state = { ...INITIAL };

  protected scenePadding(): Padding {
    return 20;
  }

  protected sceneSize(): SceneSize {
    return { w: 600, h: 200 };
  }

  connectedCallback(): void {
    super.connectedCallback();
    const { state } = this;

    // Local closure rather than a SceneElement method, since this whole
    // pattern goes away once the scene becomes a retained graph (signal
    // mutations will be the implicit render trigger).
    const ramp = (
      ms: number,
      set: (t: number) => void,
      ease: (t: number) => number = (t) => t,
    ) =>
      this.anim.tween(ms, (t) => {
        set(ease(t));
        this.render();
      });

    this.anim.loop(async () => {
      Object.assign(state, INITIAL);
      this.render();

      await ramp(1100, (t) => (state.lineT = t), easeOut);
      await this.anim.wait(240);

      await ramp(450, (t) => (state.labelsO = t));
      await this.anim.wait(720);

      // Single morph: duplicate is identical to the x-axis at morphT=0
      // (overlapping, so invisible) and is the y-axis at morphT=1.
      // Length and angle change implicitly via endpoint interpolation,
      // so it can never leave the canvas.
      await ramp(1200, (t) => (state.morphT = t), easeInOut);
      await this.anim.wait(240);

      await ramp(450, (t) => (state.yLabelsO = t));
      await this.anim.wait(240);

      await ramp(600, (t) => (state.boxO = t));
      await ramp(500, (t) => (state.centroidO = t));

      await this.anim.wait(4500);
    });
  }

  protected draw(scene: Scene): void {
    const { O, xEnd, yEnd, F, state } = this;
    const FONT = 16;
    const TICK = 7;

    const x = seg(O, xEnd);
    const y = seg(O, yEnd);
    const yMorph = seg(O, lerpPt(xEnd, yEnd, state.morphT));
    const c = pt(x.at(F.mid).x, y.at(F.mid).y);

    // Bounding box (faint, behind axes).
    if (state.boxO > 0) {
      scene.rect(
        x.at(F.min).x,
        y.at(F.max).y,
        (F.max - F.min) * (xEnd.x - O.x),
        (F.max - F.min) * (O.y - yEnd.y),
        { thin: true, opacity: state.boxO * 0.5, corner: 4 },
      );
    }

    // X-axis (animated tip) + ticks revealing as the tip passes them.
    scene.line(O, x.at(state.lineT));
    for (const f of [F.min, F.mid, F.max]) {
      const o = clamp01((state.lineT - f) / 0.06);
      if (o > 0) scene.line(...tickAt(x, f, TICK), { thin: true, opacity: o });
    }

    // Duplicate (overlaps x at morphT=0, becomes y at morphT=1).
    if (state.morphT > 0) {
      scene.line(yMorph.from, yMorph.to);
      for (const f of [F.min, F.mid, F.max]) {
        scene.line(...tickAt(yMorph, f, TICK), { thin: true });
      }
    }

    // Labels.
    if (state.labelsO > 0) {
      const xL = (p: Point, content: Content) =>
        scene.label(p, content, {
          size: FONT,
          opacity: state.labelsO,
          baseline: "top",
        });
      xL(down(x.at(F.min), 24), math("x", "min"));
      xL(down(x.at(F.mid), 24), math("x", "c"));
      xL(down(x.at(F.max), 24), math("x", "max"));
    }

    if (state.yLabelsO > 0) {
      const yL = (p: Point, content: Content) =>
        scene.label(p, content, {
          size: FONT,
          opacity: state.yLabelsO,
          anchor: "end",
          baseline: "middle",
        });
      yL(left(y.at(F.min), 14), math("y", "min"));
      yL(left(y.at(F.mid), 14), math("y", "c"));
      yL(left(y.at(F.max), 14), math("y", "max"));
    }

    // Dashed crosshairs from each axis-center mark to the centroid.
    if (state.boxO > 0) {
      const dash = { thin: true, dashed: true, opacity: state.boxO * 0.6 };
      scene.line(x.at(F.mid), c, dash);
      scene.line(y.at(F.mid), c, dash);
    }

    if (state.centroidO > 0) {
      scene.circle(c.x, c.y, 4, { fill: true, opacity: state.centroidO });
      scene.label(
        pt(c.x + 10, c.y - 10),
        t("(", math("x", "c"), ", ", math("y", "c"), ")"),
        {
          size: 14,
          opacity: state.centroidO,
          anchor: "start",
          baseline: "bottom",
        },
      );
    }
  }
}
