// minim/tex demo: factory-with-interpolation API + the full motion
// surface (write, highlight, decorations, morph, pluck/unpluck,
// writeParts, writeOut).
//
// The animation walks four sections:
//
//   A. Pythagorean derivation  ─── 5 forms of a + b = c, stresses every
//      MathML context (top-level, msup base, mfrac numerator, …).
//
//   B. Multiplication cycle    ─── 4 ways to write a · b. Includes a
//      morph through `b · a` to demonstrate "swap-via-morph": when
//      two arrangements both exist, morph naturally exchanges
//      matched-name parts. (No need for a separate `swap` primitive
//      for this case.)
//
//   C. Derivative cycle        ─── 3 ways to write df/dx; rewrite
//      mode (auto cross-fade for differing-content parts) shows when
//      x leaves the picture.
//
//   D. Pluck & outro           ─── lift `f` out and orbit it, then
//      morph back to a part-rich form for a meaningful writeParts.
//
// Note on `tex` and backslashes: the template tag reads `strings.raw`,
// so author-side LaTeX uses single backslashes (e.g. `\frac`, `\dot`,
// `\cdot`) — JS template literals don't get to eat your `\f` / `\t`.

import {
  Anchor,
  Diagram,
  Scene,
  brace,
  box,
  highlight,
  label,
  morph,
  parts,
  pluck,
  signal,
  snapshot,
  tex,
  underline,
  unpluck,
  write,
  writeOut,
  writeParts,
  type Content,
} from "../../minim";

export class MdTexDemo extends Diagram {
  protected scene(s: Scene): void {
    const view = s.view(640, 280);

    const status = signal<Content>("");

    s(
      label(view.top.down(22), "tex — derivations, representations, identity", {
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

    // ── Persistent identities ────────────────────────────────────────
    // a, b, c carry the Pythagorean cycle and (for a, b) the
    // multiplication cycle. f, x carry the derivative cycle.
    // `cross` (= the 2ab term) appears partway through the
    // Pythagorean derivation.
    const { a, b, c, cross } = parts({
      a: "a",
      b: "b",
      c: "c",
      cross: "2ab",
    });
    const { f, x } = parts({ f: "f", x: "x" });

    const tex28 = tex({ size: 28 });

    // ── Pythagorean: 5 forms ─────────────────────────────────────────
    const p1 = s(tex28`${a} + ${b} = ${c}`);
    const p2 = s(tex28`(${a} + ${b})^2 = ${c}^2`);
    const p3 = s(tex28`${a}^2 + ${cross} + ${b}^2 = ${c}^2`);
    const p4 = s(tex28`${a}^2 + ${b}^2 = ${c}^2 - ${cross}`);
    const p5 = s(tex28`\frac{${a}^2 + ${b}^2}{${c}^2 - ${cross}} = 1`);

    // ── Multiplication: 4 forms + the swap-via-morph variant ─────────
    const m1 = s(tex28`${a} \cdot ${b}`);
    const m1r = s(tex28`${b} \cdot ${a}`); // commutativity target
    const m2 = s(tex28`${a} \times ${b}`);
    const m3 = s(tex28`${a}${b}`);
    const m4 = s(tex28`(${a})(${b})`);

    // ── Derivative: 3 forms ──────────────────────────────────────────
    const d1 = s(tex28`\frac{d${f}}{d${x}}`);
    const d2 = s(tex28`${f}'(${x})`);
    const d3 = s(tex28`\dot{${f}}`);

    const eqs = [p1, p2, p3, p4, p5, m1, m1r, m2, m3, m4, d1, d2, d3];

    for (const eq of eqs) {
      eq.center.set(view.center);
      eq.opacity.value = 0;
    }

    // Decorations on p1 — three parts, one decoration each.
    // Reads as "look at each side of the equation".
    const aBox = box(p1.parts.a, { gap: 3 });
    const bUnderline = underline(p1.parts.b);
    const cBrace = brace(p1.parts.c, { placement: "below" });
    aBox.opacity.value = 0;
    bUnderline.opacity.value = 0;
    cBrace.opacity.value = 0;
    p1.add(aBox, bUnderline, cBrace);

    const reset = snapshot(
      ...eqs.map((eq) => eq.opacity),
      aBox.opacity,
      bUnderline.opacity,
      cBrace.opacity,
      status,
    );

    this.anim.loop(function* () {
      reset();
      for (const eq of eqs) eq.el.style.clipPath = "";
      yield 0.3;

      // ── A. Pythagorean derivation ────────────────────────────────
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

      status.value = "decorations — one per part, all reactive on aabb";
      yield* aBox.opacity.to(1, 0.3);
      yield 0.18;
      yield* bUnderline.opacity.to(1, 0.3);
      yield 0.18;
      yield* cBrace.opacity.to(1, 0.3);
      yield 0.7;
      yield [
        aBox.opacity.to(0, 0.3),
        bUnderline.opacity.to(0, 0.3),
        cBrace.opacity.to(0, 0.3),
      ];
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

      // ── B. Multiplication cycle ──────────────────────────────────
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

      // ── C. Derivative cycle ──────────────────────────────────────
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

      // ── D. Pluck demo ────────────────────────────────────────────
      status.value = "pluck — lift f out, orbit, then unpluck back";
      const fHandle = pluck(d1.parts.f);
      const home = fHandle.translate.peek();
      yield* fHandle.translate.to(
        { x: home.x + 90, y: home.y - 50 },
        0.45,
      );
      yield* fHandle.scale.to({ x: 1.6, y: 1.6 }, 0.3);
      yield* fHandle.translate.to(
        { x: home.x - 90, y: home.y - 50 },
        0.55,
      );
      yield* fHandle.scale.to({ x: 1, y: 1 }, 0.3);
      yield* unpluck(fHandle, undefined, 0.5);
      yield 0.5;

      // ── Outro ────────────────────────────────────────────────────
      // Land on m1 (a · b) so writeParts has something meaningful to
      // stagger — both letters are parts, the dot is the only static
      // glyph, so the reveal reads as "letters appear, dot stays".
      status.value = "morph — back to a · b for the outro";
      yield* morph(d1, m1, 0.7);
      yield 0.4;

      status.value = "writeParts — staggered fade across named parts";
      yield* writeParts(m1, 0.7);
      yield 0.5;

      status.value = "writeOut — sweep back, formula clipped to nothing";
      yield* writeOut(m1, 0.5);
      yield 0.4;
    });
  }
}
