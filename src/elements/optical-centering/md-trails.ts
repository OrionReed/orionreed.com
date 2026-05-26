import {
  type Animatable,
  Diagram,
  easeInOut,
  label,
  loop,
  Mount,
  num,
  rect,
  spring,
  tween,
  type Writable,
} from "../../minim";

const VIEW_W = 680;
const VIEW_H = 360;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2 - 16;

const POSE_DX = 120;
const POSE_DY = 70;

const SPRING_OPTS = { omega: 11, zeta: 0.4, precision: 0 } as const;

export class MdTrails extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(VIEW_W, VIEW_H);

    const target = s(
      rect(-55, -35, 110, 70, {
        fill: "transparent",
        stroke: "#1a1a1a",
        dashed: true,
        corner: 8,
      }),
    );
    target.translate.value = { x: CX, y: CY };

    const follower = s(
      rect(-55, -35, 110, 70, {
        fill: "#5b8def",
        opacity: 0.7,
        corner: 8,
        aside: true,
      }),
    );
    follower.translate.value = { x: CX, y: CY };

    // Per-property rates. Splitting them means we can pause translation
    // and rotation independently — the master envelope below cycles them
    // out of phase so you see the follower drift one axis at a time.
    const rateTranslate = num(1);
    const rateScale = num(1);
    const rateRotate = num(1);

    /** Spring `sig` toward `tgt` with a per-prop rate gate. */
    const spr = <T>(
      sig: Writable<Animatable<T, "linear" | "metric">>,
      tgt: Writable<Animatable<T, "linear" | "metric">>,
      rate: { value: number },
    ) =>
      spring(sig, tgt, {
        ...SPRING_OPTS,
        rate: () => rate.value,
      });

    this.anim.start(
      spr(follower.translate, target.translate, rateTranslate),
      spr(follower.scale, target.scale, rateScale),
      spr(follower.rotate, target.rotate, rateRotate),

      // Target keeps jumping regardless of follower's per-prop pauses.
      loop(function* () {
        yield [
          tween(
            target.translate,
            {
              x: CX + (-POSE_DX + Math.random() * 2 * POSE_DX),
              y: CY + (-POSE_DY + Math.random() * 2 * POSE_DY),
            },
            0.9,
            easeInOut,
          ),
          tween(
            target.scale,
            { x: 0.75 + Math.random() * 0.6, y: 0.75 + Math.random() * 0.6 },
            0.9,
            easeInOut,
          ),
          tween(target.rotate, -0.7 + Math.random() * 1.4, 0.9, easeInOut),
        ];
        yield 2.6;
      }),

      // Master envelope — fast → normal → translate-only paused →
      // rotate-only paused → normal. Each phase pauses one prop at a
      // time so the follower visibly drifts off-axis.
      loop(function* () {
        yield [
          tween(rateTranslate, 2, 1.2, easeInOut),
          tween(rateScale, 2, 1.2, easeInOut),
          tween(rateRotate, 2, 1.2, easeInOut),
        ];
        yield 0.7;
        yield [
          tween(rateTranslate, 1, 1.0, easeInOut),
          tween(rateScale, 1, 1.0, easeInOut),
          tween(rateRotate, 1, 1.0, easeInOut),
        ];
        yield 0.5;
        yield* tween(rateTranslate, 0, 1.0, easeInOut);
        yield 2.0;
        yield* tween(rateTranslate, 1, 1.0, easeInOut);
        yield 0.4;
        yield* tween(rateRotate, 0, 1.0, easeInOut);
        yield 2.0;
        yield* tween(rateRotate, 1, 1.0, easeInOut);
        yield 0.4;
      }),
    );

    s(
      label(view.top.down(22), "per-property springs · pause translate or rotate independently"),
      label(view.top.down(40), "each rate is a separate signal · master cycles them out of phase", {
        size: 10,
      }),
    );
  }
}
