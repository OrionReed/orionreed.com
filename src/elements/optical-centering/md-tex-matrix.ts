// minim/tex demo: matrix × vector, written compact then evaluated.
//
// Exercises:
//   • Display mode (`tex({ display: "block" })`) — required for
//     `\begin{pmatrix}…\end{pmatrix}` to render with proper bracket
//     sizing and row spacing.
//   • Per-cell identity carried across structurally different forms.
//     Each matrix cell (a, b, c, d) and each vector cell (x, y) is
//     a part — they ride from their compact slots into the result
//     vector's expressions on the right.
//   • Color tagging the row-vector pairings (top row red, bottom row
//     blue) so the user sees which letters land where.

import {
  Anchor,
  Diagram,
  Scene,
  highlight,
  label,
  morph,
  part,
  parts,
  signal,
  snapshot,
  tex,
  write,
  writeOut,
  type Content,
} from "../../minim";

const RED = "#e25c5c";
const BLUE = "#5b8def";

// LaTeX commands held as JS-string constants — avoids triggering
// Cursor's TS grammar bug when raw-template literals contain `\b…`,
// `\p…`, `_{…=…}` etc. (See md-tex-correspond for prior art.)
const PMATRIX_OPEN = "\\begin{pmatrix}";
const PMATRIX_CLOSE = "\\end{pmatrix}";

const block = tex({ display: "block" });

export class MdTexMatrix extends Diagram {
  protected scene(s: Scene): void {
    const view = s.view(640, 280);

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

    // Cells: top row {a, b}, bottom row {c, d}; vector {x, y}.
    // a, b, c, d each appear once on each side → simple 1↔1 ride.
    // x and y each appear ONCE on the compact side but TWICE on the
    // evaluated side (once per row). So they need `expand` — the
    // top-row use and the bottom-row use are *components of the same
    // identity*, individually addressable by their derived names.
    // Morph then sees x's identity as 1↔2 and fans it out (forward)
    // / folds it in (reverse).
    const { a, b, c, d } = parts("a", "b", "c", "d");
    const x = part("x");
    const y = part("y");
    const { xTop, xBot } = x.expand({ xTop: "x", xBot: "x" });
    const { yTop, yBot } = y.expand({ yTop: "y", yBot: "y" });

    // Compact: 2×2 matrix times a 2-vector. The `\\` between rows
    // is LaTeX's row separator (raw-template mode preserves both
    // backslashes verbatim — temml sees `\\`).
    const compact = s(
      block`${PMATRIX_OPEN} ${a} & ${b} \\ ${c} & ${d} ${PMATRIX_CLOSE} ${PMATRIX_OPEN} ${x} \\ ${y} ${PMATRIX_CLOSE}`,
    );

    // Evaluated: each component of the result is a sum of products.
    // Top row uses xTop / yTop; bottom row uses xBot / yBot. These
    // are 4 distinct named parts but share x's and y's identity.
    const evaluated = s(
      block`${PMATRIX_OPEN} ${a}${xTop} + ${b}${yTop} \\ ${c}${xBot} + ${d}${yBot} ${PMATRIX_CLOSE}`,
    );

    const eqs = [compact, evaluated];

    for (const eq of eqs) {
      eq.center.set(view.center);
      eq.opacity.value = 0;
    }

    // Color by row: a, b in top row red; c, d in bottom row blue.
    // x and y are vector cells — color them green so the user sees
    // the column vector contributing to BOTH result rows. The
    // expanded copies (xTop, xBot, yTop, yBot) on the evaluated side
    // also get green so the tagging follows the fan-out.
    const GREEN = "#3aa56b";
    const tagColors = (): void => {
      compact.parts.a.color.value = RED;
      compact.parts.b.color.value = RED;
      compact.parts.c.color.value = BLUE;
      compact.parts.d.color.value = BLUE;
      compact.parts.x.color.value = GREEN;
      compact.parts.y.color.value = GREEN;
      evaluated.parts.a.color.value = RED;
      evaluated.parts.b.color.value = RED;
      evaluated.parts.c.color.value = BLUE;
      evaluated.parts.d.color.value = BLUE;
      evaluated.parts.xTop.color.value = GREEN;
      evaluated.parts.xBot.color.value = GREEN;
      evaluated.parts.yTop.color.value = GREEN;
      evaluated.parts.yBot.color.value = GREEN;
    };

    const reset = snapshot(
      compact.opacity,
      evaluated.opacity,
      compact.parts.a.color,
      compact.parts.b.color,
      compact.parts.c.color,
      compact.parts.d.color,
      compact.parts.x.color,
      compact.parts.y.color,
      evaluated.parts.a.color,
      evaluated.parts.b.color,
      evaluated.parts.c.color,
      evaluated.parts.d.color,
      evaluated.parts.xTop.color,
      evaluated.parts.xBot.color,
      evaluated.parts.yTop.color,
      evaluated.parts.yBot.color,
      status,
    );

    this.anim.loop(function* () {
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
    });
  }
}
