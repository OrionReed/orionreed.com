import {Anchor, Diagram, Mount, signal, label, loop, snapshot, type Content} from "../../minim";
import {highlight, morph, part, parts, tex, tint, write, writeOut} from "../../minim/tex";

const RED = "#e25c5c";
const BLUE = "#5b8def";
const GREEN = "#3aa56b";

const PMATRIX_OPEN = "\\begin{pmatrix}";
const PMATRIX_CLOSE = "\\end{pmatrix}";

const block = tex({ display: "block" });

export class MdTexMatrix extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 280);

    const status = signal<Content>("");

    s(
      label(view.top.down(22), "tex — matrix × vector, compact ↔ evaluated", {
        size: 12,
        opacity: 0.55,
        align: Anchor.Center,
      }),
      label(view.bottom.up(22), status, {
        size: 11,
        opacity: 0.45,
        align: Anchor.Center,
      }),
    );

    // x/y appear twice on the evaluated side → `expand` so both share one identity.
    const { a, b, c, d } = parts("a", "b", "c", "d");
    const x = part("x");
    const y = part("y");
    const { xTop, xBot } = x.expand({ xTop: "x", xBot: "x" });
    const { yTop, yBot } = y.expand({ yTop: "y", yBot: "y" });

    const compact = s(
      block`${PMATRIX_OPEN} ${a} & ${b} \\ ${c} & ${d} ${PMATRIX_CLOSE} ${PMATRIX_OPEN} ${x} \\ ${y} ${PMATRIX_CLOSE}`,
    );
    const evaluated = s(
      block`${PMATRIX_OPEN} ${a}${xTop} + ${b}${yTop} \\ ${c}${xBot} + ${d}${yBot} ${PMATRIX_CLOSE}`,
    );

    const eqs = [compact, evaluated];
    for (const eq of eqs) {
      eq.center.set(view.center);
      eq.opacity.value = 0;
    }

    const tagColors = (): void => {
      tint(RED, a, b);
      tint(BLUE, c, d);
      tint(GREEN, x, y);
    };

    const reset = snapshot(
      compact.opacity,
      evaluated.opacity,
      a.color,
      b.color,
      c.color,
      d.color,
      x.color,
      y.color,
      status,
    );

    this.anim.start(loop(function* () {
      reset();
      yield 0.3;

      status.value = "write — compact form";
      compact.opacity.value = 1;
      yield* write(compact, 0.7);
      yield 0.4;

      status.value = "highlight — top row, then bottom row";
      yield* highlight(compact.parts.a, 0.3);
      yield 0.05;
      yield* highlight(compact.parts.b, 0.3);
      yield 0.2;
      yield* highlight(compact.parts.c, 0.3);
      yield 0.05;
      yield* highlight(compact.parts.d, 0.3);
      yield 0.4;

      status.value = "color — rows red/blue, vector green (used in both rows)";
      tagColors();
      yield 0.6;

      status.value = "morph — evaluate the product";
      yield* morph(compact, evaluated, 1.0);
      yield 1.0;

      status.value = "morph — back to compact form";
      yield* morph(evaluated, compact, 1.0);
      yield 0.7;

      status.value = "writeOut";
      yield* writeOut(compact, 0.5);
      yield 0.4;
    }));
  }
}
