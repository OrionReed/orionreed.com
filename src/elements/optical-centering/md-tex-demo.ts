// Stage 0–2 of the tex package — `tex\`…\`` template, addressable
// parts, decorations, highlight, write, writeParts, morph. Cycles
// through a Pythagorean theorem narrative so each primitive shows
// up on its own with a captioned label.

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
    const view = s.view(560, 240);

    s(
      label(view.top.down(22), "tex — write, decorate, morph", {
        size: 12,
        opacity: 0.55,
        align: Anchor.Center,
      }),
    );

    const status = signal<Content>("");
    s(
      label(view.bottom.up(22), status, {
        size: 11,
        opacity: 0.45,
        align: Anchor.Center,
      }),
    );

    // Pythagorean theorem in three equivalent forms. Each shares
    // the named parts `a`, `b`, `c`, so morph can carry their
    // identity across — and the parts traverse three different
    // ambient MathML contexts (top-level mrow, inside `<msqrt>`,
    // inside `<mfrac>` numerator/denominator), which is the real
    // stress test for context-independent rendering.
    const tex28 = tex({ size: 28 });
    const eq1 =
      s(tex28`${part("a", "a^2")} + ${part("b", "b^2")} = ${part("c", "c^2")}`);
    const eq2 =
      s(tex28`${part("c", "c")} = \\sqrt{${part("a", "a^2")} + ${part("b", "b^2")}}`);
    const eq3 =
      s(tex28`\\frac{${part("a", "a^2")} + ${part("b", "b^2")}}{${part("c", "c^2")}} = 1`);

    const eqs = [eq1, eq2, eq3];

    // TODO(stage-2): once anchors are writable, this collapses to
    //   `eq.center.bind(view.center)` per eq.
    const c = view.center.value;
    for (const eq of eqs) {
      eq.translate.value = {
        x: c.x - eq.width.peek() / 2,
        y: c.y - eq.height.peek() / 2,
      };
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

      status.value = "morph — top-level → inside √";
      yield* morph(eq1, eq2, 0.7);
      yield 0.8;

      status.value = "morph — inside √ → inside fraction";
      yield* morph(eq2, eq3, 0.7);
      yield 0.8;

      status.value = "morph — inside fraction → top-level";
      yield* morph(eq3, eq1, 0.7);
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
