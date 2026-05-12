// Stage 0–2 of the tex package — `tex\`…\`` template, addressable
// parts, decorations, highlight, write, writeParts, morph.
//
// Cycles through a five-step derivation of `(a + b)² = c² − 2ab`,
// chosen so the same identity letters traverse every ambient MathML
// context the morph rider needs to handle:
//
//   eq1: top-level mrow                   →  a + b = c
//   eq2: inside paren-group / msup base   →  (a + b)² = c²
//   eq3: parts split, `2ab` cross appears →  a² + 2ab + b² = c²
//   eq4: cross moves across               →  a² + b² = c² − 2ab
//   eq5: everything enters <mfrac>        →  (a² + b²) / (c² − 2ab) = 1
//
// `a`, `b`, `c` carry their identity through every step (content
// stays just the bare letter, so morph rides them byte-identically
// even though their *surroundings* change drastically). `cross`
// (= `2ab`) appears in eq3 and rides through eq4 → eq5; on the
// eq5 → eq1 morph it has no destination and cross-fades with the
// rest of eq5.

import {
  Anchor,
  Diagram,
  Scene,
  brace,
  box,
  highlight,
  label,
  morph,
  part,
  signal,
  snapshot,
  tex,
  underline,
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
      label(view.top.down(22), "tex — derivation: (a + b)² and beyond", {
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

    // Persistent identities. `a`, `b`, `c` are bare letters so the
    // matched mrow contains exactly one glyph in every form — morph
    // rides them through paren-groups, msup bases, mfrac numerators
    // and denominators with byte-identical handoffs. `cross` is the
    // `2ab` term that appears at eq3 and persists through eq5.
    const a = part("a", "a");
    const b = part("b", "b");
    const c = part("c", "c");
    const cross = part("cross", "2ab");

    const tex28 = tex({ size: 28 });
    const eq1 = s(tex28`${a} + ${b} = ${c}`);
    const eq2 = s(tex28`(${a} + ${b})^2 = ${c}^2`);
    const eq3 = s(tex28`${a}^2 + ${cross} + ${b}^2 = ${c}^2`);
    const eq4 = s(tex28`${a}^2 + ${b}^2 = ${c}^2 - ${cross}`);
    const eq5 = s(
      tex28`\\frac{${a}^2 + ${b}^2}{${c}^2 - ${cross}} = 1`,
    );

    const eqs = [eq1, eq2, eq3, eq4, eq5];

    // Writable anchor → translate lens: writes the delta needed to land
    // each equation's center on the view's. `set` is one-shot (no
    // ongoing tracking).
    for (const eq of eqs) {
      eq.center.set(view.center);
      eq.opacity.value = 0;
    }

    // Decorations as children of eq1 so they ride its transform.
    const cBrace = brace(eq1.parts.c, { placement: "below" });
    const aBox = box(eq1.parts.a, { gap: 3 });
    const bUnderline = underline(eq1.parts.b);
    cBrace.opacity.value = 0;
    aBox.opacity.value = 0;
    bUnderline.opacity.value = 0;
    eq1.add(cBrace, aBox, bUnderline);

    // Snapshot the just-initialized "everything hidden, status blank" state
    // so each loop iteration restores it in one call. Clip-path is a
    // direct DOM mutation (not a signal), so it's reset alongside.
    const reset = snapshot(
      eq1.opacity,
      eq2.opacity,
      eq3.opacity,
      eq4.opacity,
      eq5.opacity,
      cBrace.opacity,
      aBox.opacity,
      bUnderline.opacity,
      status,
    );

    this.anim.loop(function* () {
      reset();
      for (const eq of eqs) eq.el.style.clipPath = "";
      yield 0.4;

      status.value = "write — clip-path sweep, left → right";
      eq1.opacity.value = 1;
      yield* write(eq1, 0.7);
      yield 0.5;

      status.value = "highlight — per-part flash";
      yield* highlight(eq1.parts.a, 0.4);
      yield 0.08;
      yield* highlight(eq1.parts.b, 0.4);
      yield 0.08;
      yield* highlight(eq1.parts.c, 0.4);
      yield 0.4;

      status.value = "decorations — brace, box, underline track parts";
      yield* cBrace.opacity.to(1, 0.3);
      yield 0.18;
      yield* aBox.opacity.to(1, 0.3);
      yield 0.18;
      yield* bUnderline.opacity.to(1, 0.3);
      yield 0.7;

      yield [
        cBrace.opacity.to(0, 0.3),
        aBox.opacity.to(0, 0.3),
        bUnderline.opacity.to(0, 0.3),
      ];
      yield 0.25;

      status.value = "morph — square both sides";
      yield* morph(eq1, eq2, 0.7);
      yield 0.7;

      status.value = "morph — expand the square (cross term appears)";
      yield* morph(eq2, eq3, 0.7);
      yield 0.7;

      status.value = "morph — rearrange (cross moves across)";
      yield* morph(eq3, eq4, 0.7);
      yield 0.7;

      status.value = "morph — divide (parts enter fraction context)";
      yield* morph(eq4, eq5, 0.8);
      yield 0.9;

      status.value = "morph — back to the start (parts leave fraction)";
      yield* morph(eq5, eq1, 0.8);
      yield 0.6;

      status.value = "writeParts — staggered fade across named parts";
      yield* writeParts(eq1, 0.7);
      yield 0.6;

      status.value = "writeOut — sweep back, formula clipped to nothing";
      yield* writeOut(eq1, 0.5);
      yield 0.6;
    });
  }
}
