// `tex` reads strings.raw, so use single backslashes (`\frac`, `\dot`, `\cdot`).

import {
  type Content,
  Diagram,
  label,
  loop,
  type Mount,
  cell,
  snapshot,
  stagger,
} from "../../minim";
import {
  brace,
  frame,
  highlight,
  morph,
  part,
  parts,
  pluck,
  tex,
  tint,
  underline,
  unpluck,
  write,
  writeOut,
} from "../../minim/tex";

const RED = "#e25c5c";
const BLUE = "#5b8def";
const GREEN = "#3aa56b";

const PMATRIX_OPEN = "\\begin{pmatrix}";
const PMATRIX_CLOSE = "\\end{pmatrix}";

const block = tex({ display: "block" });

export class MdTexDemo extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 280);

    const status = cell<Content>("");

    s(
      label(view.top.down(22), "tex — derivations, representations, identity"),
      label(view.bottom.up(22), status),
    );

    const { a, b, c, cross } = parts("a", "b", "c", { cross: "2ab" });
    const { f, x } = parts("f", "x");

    const p1 = s(tex`${a} + ${b} = ${c}`);
    const p2 = s(tex`(${a} + ${b})^2 = ${c}^2`);
    const p3 = s(tex`${a}^2 + ${cross} + ${b}^2 = ${c}^2`);
    const p4 = s(tex`${a}^2 + ${b}^2 = ${c}^2 - ${cross}`);
    const p5 = s(tex`\frac{${a}^2 + ${b}^2}{${c}^2 - ${cross}} = 1`);

    // Substitution sequence — `.with(...)` swaps a part's body while
    // preserving its identity through morphs.
    const sub1 = s(tex`${a.with("2")} + ${b} = ${c}`);
    const sub2 = s(tex`${a.with("2")} + ${b.with("3")} = ${c}`);
    const sub3 = s(tex`${a.with("2")} + ${b.with("3")} = ${c.with("5")}`);

    const m1 = s(tex`${a} \cdot ${b}`);
    const m1r = s(tex`${b} \cdot ${a}`);
    const m2 = s(tex`${a} \times ${b}`);
    const m3 = s(tex`${a}${b}`);
    const m4 = s(tex`(${a})(${b})`);

    const d1 = s(tex`\frac{d${f}}{d${x}}`);
    const d2 = s(tex`${f}'(${x})`);
    const d3 = s(tex`\dot{${f}}`);

    // Matrix × vector — `expand` lets x/y appear twice in the evaluated
    // form while sharing one identity with their compact origin.
    const mA = part("mA", "a");
    const mB = part("mB", "b");
    const mC = part("mC", "c");
    const mD = part("mD", "d");
    const vX = part("vX", "x");
    const vY = part("vY", "y");
    const { xTop, xBot } = vX.expand({ xTop: "x", xBot: "x" });
    const { yTop, yBot } = vY.expand({ yTop: "y", yBot: "y" });
    const mxCompact = s(
      block`${PMATRIX_OPEN} ${mA} & ${mB} \\ ${mC} & ${mD} ${PMATRIX_CLOSE} ${PMATRIX_OPEN} ${vX} \\ ${vY} ${PMATRIX_CLOSE}`,
    );
    const mxEvaluated = s(
      block`${PMATRIX_OPEN} ${mA}${xTop} + ${mB}${yTop} \\ ${mC}${xBot} + ${mD}${yBot} ${PMATRIX_CLOSE}`,
    );

    const eqs = [
      p1,
      p2,
      p3,
      p4,
      p5,
      sub1,
      sub2,
      sub3,
      m1,
      m1r,
      m2,
      m3,
      m4,
      d1,
      d2,
      d3,
      mxCompact,
      mxEvaluated,
    ];

    for (const eq of eqs) {
      eq.center.value = view.center.peek();
      eq.opacity.value = 0;
    }

    const aBox = frame(p1.parts.a, { gap: 3 });
    const bUnderline = underline(p1.parts.b);
    const cBrace = brace(p1.parts.c, { placement: "below" });
    aBox.opacity.value = 0;
    bUnderline.opacity.value = 0;
    cBrace.opacity.value = 0;
    p1.add(aBox, bUnderline, cBrace);

    const reset = snapshot(
      ...eqs.map(eq => eq.opacity),
      aBox.opacity,
      bUnderline.opacity,
      cBrace.opacity,
      a.color,
      b.color,
      c.color,
      mA.color,
      mB.color,
      mC.color,
      mD.color,
      vX.color,
      vY.color,
      status,
    );

    this.anim.start(
      loop(function* () {
        reset();
        for (const eq of eqs) eq.el.style.clipPath = "";
        yield 0.3;

        status.value = "write — clip-path sweep, left → right";
        p1.opacity.value = 1;
        yield* write(p1, 0.7);
        yield 0.4;

        status.value = "highlight — per-part flash";
        yield* highlight(p1.parts.a, 0.4);
        yield 0.08;
        yield* highlight(p1.parts.b, 0.4);
        yield 0.08;
        yield* highlight(p1.parts.c, 0.4);
        yield 0.4;

        status.value = "decorations — one per part, all reactive on box";
        yield* aBox.opacity.to(1, 0.3);
        yield 0.18;
        yield* bUnderline.opacity.to(1, 0.3);
        yield 0.18;
        yield* cBrace.opacity.to(1, 0.3);
        yield 0.7;
        yield [aBox.opacity.to(0, 0.3), bUnderline.opacity.to(0, 0.3), cBrace.opacity.to(0, 0.3)];
        yield 0.3;

        status.value = "morph — square both sides";
        yield* morph(p1, p2, 0.7);
        yield 0.5;

        status.value = "morph — expand the square (cross term appears)";
        yield* morph(p2, p3, 0.7);
        yield 0.5;

        status.value = "morph — rearrange (cross moves across)";
        yield* morph(p3, p4, 0.7);
        yield 0.5;

        status.value = "morph — divide (parts enter fraction context)";
        yield* morph(p4, p5, 0.8);
        yield 0.7;

        status.value = "morph — back to the start";
        yield* morph(p5, p1, 0.8);
        yield 0.5;

        status.value = "tint — colour the substitutable parts";
        tint(GREEN, a, b, c);
        yield 0.4;

        status.value = "substitute — a → 2 (via .with)";
        yield* morph(p1, sub1, 0.55);
        yield 0.2;
        status.value = "substitute — b → 3";
        yield* morph(sub1, sub2, 0.55);
        yield 0.2;
        status.value = "substitute — c → 5";
        yield* morph(sub2, sub3, 0.55);
        yield 0.6;
        status.value = "morph — restore symbolic form";
        yield* morph(sub3, p1, 0.7);
        yield 0.4;

        status.value = "morph — rewrite as a product (cross-cycle)";
        yield* morph(p1, m1, 0.7);
        yield 0.5;

        status.value = "morph — a · b ↔ b · a (commutativity, via morph)";
        yield* morph(m1, m1r, 0.7);
        yield 0.4;
        yield* morph(m1r, m1, 0.6);
        yield 0.5;

        status.value = "morph — a · b → a × b (operator rewrite)";
        yield* morph(m1, m2, 0.6);
        yield 0.4;

        status.value = "morph — a × b → ab (juxtaposition)";
        yield* morph(m2, m3, 0.6);
        yield 0.4;

        status.value = "morph — ab → (a)(b) (parenthesized)";
        yield* morph(m3, m4, 0.6);
        yield 0.4;

        status.value = "morph — back to a · b";
        yield* morph(m4, m1, 0.6);
        yield 0.5;

        status.value = "morph — to df/dx (cross-cycle)";
        yield* morph(m1, d1, 0.8);
        yield 0.5;

        status.value = "morph — df/dx → f'(x) (Leibniz → Lagrange)";
        yield* morph(d1, d2, 0.7);
        yield 0.4;

        status.value = "morph — f'(x) → ḟ (Newton — x leaves)";
        yield* morph(d2, d3, 0.7);
        yield 0.4;

        status.value = "morph — back to df/dx";
        yield* morph(d3, d1, 0.7);
        yield 0.5;

        status.value = "pluck — lift f out, orbit, then unpluck back";
        const fHandle = pluck(d1.parts.f);
        const home = fHandle.translate.peek();
        yield* fHandle.translate.to({ x: home.x + 90, y: home.y - 50 }, 0.45);
        yield* fHandle.scale.to({ x: 1.6, y: 1.6 }, 0.3);
        yield* fHandle.translate.to({ x: home.x - 90, y: home.y - 50 }, 0.55);
        yield* fHandle.scale.to({ x: 1, y: 1 }, 0.3);
        yield* unpluck(fHandle, undefined, 0.5);
        yield 0.5;

        status.value = "morph — back to a · b";
        yield* morph(d1, m1, 0.7);
        yield 0.4;

        status.value = "writeOut — sweep back, formula clipped to nothing";
        yield* writeOut(m1, 0.5);
        yield 0.4;

        // Block-display matrix × vector — `tint` for row/column identity,
        // `expand` so the same x/y appear in both evaluated rows.
        status.value = "write — block matrix × vector (compact)";
        mxCompact.opacity.value = 1;
        yield* write(mxCompact, 0.7);
        yield 0.4;

        status.value = "tint — rows red/blue, vector green (used in both rows)";
        tint(RED, mA, mB);
        tint(BLUE, mC, mD);
        tint(GREEN, vX, vY);
        yield 0.6;

        status.value = "morph — evaluate the product (expand fans x, y in)";
        yield* morph(mxCompact, mxEvaluated, 1.0);
        yield 1.0;

        status.value = "morph — back to compact form";
        yield* morph(mxEvaluated, mxCompact, 1.0);
        yield 0.4;

        status.value = "stagger — per-part fade-in across the row";
        for (const p of mxCompact.parts) p.opacity.value = 0;
        yield* stagger(0.08, mxCompact.parts, p => p.opacity.to(1, 0.35));
        yield 0.4;

        status.value = "writeOut — sweep back";
        yield* writeOut(mxCompact, 0.5);
        yield 0.4;
      }),
    );
  }
}
