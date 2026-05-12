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
  css,
  highlight,
  label,
  morph,
  part,
  pt,
  signal,
  tex,
  underline,
  write,
  writeOut,
  writeParts,
  type Content,
} from "../../minim";

export class MdTexDemo extends Diagram {
  // note: I think it would be nice to not need to have static styles like this in diagrams.
  // its worth thinking about how diagrams should be integrated into webpages, for sure. Atm we're kinda YOLOing it and dont have a good principled approach
  static styles = css`
    :host {
      --scene-max-width: 580px;
    }
  `;

  protected scene(s: Scene): void {
    const W = 560;
    const H = 240;
    // note: we should probably update s.view to just take W/H, we never use the x/y
    s.view(0, 0, W, H);

    // note: this is the same as getting the bounds (from s.view) and then getting the center, no?
    const cx = W / 2;
    const cy = H / 2;

    // note: for builtin shapes, we may want to add s.label (etc) to avoid the extra newlines created from formatting...
    // idk if there's some way to let custom shapes (like tex) do this in a sane way too, or if it'd only work for priveledged/default shapes...
    s(
      label(pt(cx, 22), "tex — write, decorate, morph", {
        size: 12,
        opacity: 0.55,
        align: Anchor.Center,
      }),
    );

    const status = signal<Content>("");
    s(
      label(pt(cx, H - 22), status, {
        size: 11,
        opacity: 0.45,
        align: Anchor.Center,
      }),
    );

    // Pythagorean theorem and its solved form for `c`. Both share
    // named parts `a`, `b`, `c` so morph can match them across.
    const eq1 = s(
      tex({
        size: 28,
      })`${part("a", "a^2")} + ${part("b", "b^2")} = ${part("c", "c^2")}`,
    );
    const eq2 = s(
      tex({
        size: 28,
      })`${part("c", "c")} = \\sqrt{${part("a", "a^2")} + ${part("b", "b^2")}}`,
    );

    // note: i guess we have to do this here because its not a Bounds.. probs okay, hm.
    eq1.translate.value = {
      x: cx - eq1.width.peek() / 2,
      y: cy - eq1.height.peek() / 2,
    };
    eq2.translate.value = {
      x: cx - eq2.width.peek() / 2,
      y: cy - eq2.height.peek() / 2,
    };

    eq1.opacity.value = 0;
    eq2.opacity.value = 0;

    // Decorations as children of eq1 so they ride its transform.
    const cBrace = brace(eq1.parts.c, { placement: "below" });
    const aBox = box(eq1.parts.a, { gap: 3 });
    const bUnderline = underline(eq1.parts.b);
    cBrace.opacity.value = 0;
    aBox.opacity.value = 0;
    bUnderline.opacity.value = 0;
    eq1.add(cBrace, aBox, bUnderline);

    // hypothetical util:
    // setVals(cBrace.opacity, aBox.opacity, bUnderline.opacity)(0)
    // or maybe snapshot() could also accept a value (if TS can infer: all signals are T, then accept T, else accept no value)
    // so snapshot(cBrace.opacity, aBox.opacity, bUnderline.opacity)(0)
    // or:
    // const reset = snapshot(cBrace.opacity, aBox.opacity, bUnderline.opacity)
    // reset(0)

    this.anim.loop(function* () {
      // note: stage comments are redundant, given that we have labels...
      // ── Reset ────────────────────────────────────────────────
      eq1.opacity.value = 0;
      eq2.opacity.value = 0;
      cBrace.opacity.value = 0;
      aBox.opacity.value = 0;
      bUnderline.opacity.value = 0;
      status.value = "";
      eq1.el.style.clipPath = "";
      eq2.el.style.clipPath = "";
      yield 0.4;

      // ── 1. Write the formula in (clip-path sweep) ────────────
      status.value = "write — clip-path sweep, left → right";
      eq1.opacity.value = 1;
      yield* write(eq1, 0.7);
      yield 0.5;

      // ── 2. Highlight cycle (per-part bg flash) ───────────────
      status.value = "highlight — per-part flash";
      yield* highlight(eq1.parts.a, 0.4);
      yield 0.08;
      yield* highlight(eq1.parts.b, 0.4);
      yield 0.08;
      yield* highlight(eq1.parts.c, 0.4);
      yield 0.4;

      // ── 3. Decorations stagger in ────────────────────────────
      status.value = "decorations — brace, box, underline track parts";
      yield* cBrace.opacity.to(1, 0.3);
      yield 0.18;
      yield* aBox.opacity.to(1, 0.3);
      yield 0.18;
      yield* bUnderline.opacity.to(1, 0.3);
      yield 0.7;

      // ── 4. Decorations fade out together ─────────────────────
      yield [
        cBrace.opacity.to(0, 0.3),
        aBox.opacity.to(0, 0.3),
        bUnderline.opacity.to(0, 0.3),
      ];
      yield 0.25;

      // ── 5. Morph to solved form (matched by name: a, b, c) ──
      status.value = "morph — matched parts a, b, c carry across";
      yield* morph(eq1, eq2, 0.7);
      yield 1.0;

      // ── 6. Show writeParts on a fresh re-entry ───────────────
      status.value = "writeParts — staggered fade across named parts";
      yield* morph(eq2, eq1, 0.6);
      yield 0.4;
      yield* writeParts(eq1, 0.7);
      yield 0.6;

      // ── 7. WriteOut sweep ────────────────────────────────────
      status.value = "writeOut — sweep back, formula clipped to nothing";
      yield* writeOut(eq1, 0.5);
      yield 0.6;
    });
  }
}
