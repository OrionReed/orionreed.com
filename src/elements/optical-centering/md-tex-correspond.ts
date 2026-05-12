// minim/tex correspondence demo: identity across structurally
// distinct representations.
//
// The first tex demo (md-tex-demo) exercises 1↔1 identity — a part
// at one slot, possibly with different content, rides to a slot in
// another form. This demo exercises the next two regimes:
//
//   1↔N (fan-out)  ─── one symbol corresponds to many in another form
//                      e.g. \vec v  ↔  (v_x, v_y, v_z),
//                           \sum a_i ↔  a_1 + a_2 + a_3
//                      Authoring: marker.expand({...}) produces N
//                      child markers that share the parent's identity.
//                      Morph fans them out from the parent's slot.
//
//   substitution  ─── same identity, different content, staggered
//                      e.g. a + b = c   →   2 + 3 = 5
//                      Authoring: marker.with(newContent) for each
//                      eq's substituted form. Three back-to-back
//                      morphs naturally stagger.
//
// Color (Part.color) draws the eye to the identity that's about to
// transform — Manim-style "watch this red letter" cuing.

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

// Two correspondence colors, chosen for legibility on both light and
// dark themes. Used to "tag" identities that are about to transform —
// the user sees the red letter, then sees red letters appear.
const RED = "#e25c5c";
const BLUE = "#5b8def";
const GREEN = "#3aa56b";

// LaTeX commands extracted as JS strings rather than written inline in
// `tex` template literals. Equivalent at runtime (interpolated
// strings splice through verbatim), but avoids syntax-highlighter
// trips on `\sum`, `\vec`, `\frac`, and especially on patterns like
// `_{i=1}` (assignment-looking content inside `{}` inside a template
// literal) which Cursor's TS grammar misparses.
const VEC_V = "\\vec{v}";
const SUM_RANGE = "\\sum_{i=1}^{3}";

export class MdTexCorrespond extends Diagram {
  protected scene(s: Scene): void {
    const view = s.view(640, 260);

    const status = signal<Content>("");

    s(
      label(view.top.down(22), "tex — identity across representations", {
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

    // ── Section A: vector ↔ component identity (1 ↔ 3) ──────────────
    // v.expand({...}) makes vx, vy, vz first-class addressable parts
    // (each has its own name, decoratable, etc.) but threads them
    // back to v as the identity root. Morph fans v out into the three.
    const v = part("v", VEC_V);
    const { vx, vy, vz } = v.expand({
      vx: "v_x",
      vy: "v_y",
      vz: "v_z",
    });
    const vSym = s(tex`${v}`);
    const vComp = s(tex`(${vx}, ${vy}, ${vz})`);

    // ── Section B: sum ↔ expansion (1 ↔ 3, structural) ──────────────
    // The \sum operator and its bounds vanish on the right (no
    // counterpart, parent crossfade); the body a_i fans out into
    // the three concrete terms via the same expand mechanism.
    const ai = part("ai", "a_i");
    const { a1, a2, a3 } = ai.expand({
      a1: "a_1",
      a2: "a_2",
      a3: "a_3",
    });
    const sigma = s(tex`${SUM_RANGE} ${ai}`);
    const flat = s(tex`${a1} + ${a2} + ${a3}`);

    // ── Section C: concrete numbers (staggered substitution) ────────
    // Three intermediate equations hold the substitution chain. Each
    // morph rewrites one part (a → 2, b → 3, c → 5) — the others
    // ride byte-identically because they share the same marker, so
    // the staggering reads as "this letter just turned into a
    // number, now this one, now this one."
    const { a, b, c } = parts("a", "b", "c");
    const sym = s(tex`${a} + ${b} = ${c}`);
    const sub1 = s(tex`${a.with("2")} + ${b} = ${c}`);
    const sub2 = s(tex`${a.with("2")} + ${b.with("3")} = ${c}`);
    const sub3 = s(tex`${a.with("2")} + ${b.with("3")} = ${c.with("5")}`);

    const eqs = [vSym, vComp, sigma, flat, sym, sub1, sub2, sub3];

    for (const eq of eqs) {
      eq.center.set(view.center);
      eq.opacity.value = 0;
    }

    const reset = snapshot(
      ...eqs.map((eq) => eq.opacity),
      vSym.parts.v.color,
      vComp.parts.vx.color,
      vComp.parts.vy.color,
      vComp.parts.vz.color,
      sigma.parts.ai.color,
      flat.parts.a1.color,
      flat.parts.a2.color,
      flat.parts.a3.color,
      sym.parts.a.color,
      sym.parts.b.color,
      sym.parts.c.color,
      sub1.parts.a.color,
      sub2.parts.a.color,
      sub2.parts.b.color,
      sub3.parts.a.color,
      sub3.parts.b.color,
      sub3.parts.c.color,
      status,
    );

    this.anim.loop(function* () {
      reset();
      yield 0.3;

      // ── A. Vector ↔ components ───────────────────────────────────
      status.value = "write — \\vec{v}";
      vSym.opacity.value = 1;
      yield* write(vSym, 0.6);
      yield 0.3;

      status.value = "color — tag the identity (v will become 3 things)";
      vSym.parts.v.color.value = RED;
      vComp.parts.vx.color.value = RED;
      vComp.parts.vy.color.value = RED;
      vComp.parts.vz.color.value = RED;
      yield* highlight(vSym.parts.v, 0.4);
      yield 0.4;

      status.value = "morph — \\vec{v} → (v_x, v_y, v_z)  (1↔3 fan-out)";
      yield* morph(vSym, vComp, 0.8);
      yield 0.7;

      status.value = "morph — back  (3↔1 fan-in)";
      yield* morph(vComp, vSym, 0.8);
      yield 0.7;

      status.value = "writeOut";
      yield* writeOut(vSym, 0.4);
      yield 0.2;

      // ── B. Sum ↔ expansion ───────────────────────────────────────
      sigma.opacity.value = 1;
      status.value = "write — \\sum_{i=1}^{3} a_i";
      yield* write(sigma, 0.6);
      yield 0.3;

      status.value = "color — body a_i ⇒ three terms";
      sigma.parts.ai.color.value = BLUE;
      flat.parts.a1.color.value = BLUE;
      flat.parts.a2.color.value = BLUE;
      flat.parts.a3.color.value = BLUE;
      yield* highlight(sigma.parts.ai, 0.4);
      yield 0.4;

      status.value =
        "morph — \\sum a_i → a_1 + a_2 + a_3  (operator vanishes, body fans out)";
      yield* morph(sigma, flat, 0.85);
      yield 0.7;

      status.value = "morph — back";
      yield* morph(flat, sigma, 0.85);
      yield 0.7;

      status.value = "writeOut";
      yield* writeOut(sigma, 0.4);
      yield 0.2;

      // ── C. Concrete numbers (staggered substitution) ─────────────
      sym.opacity.value = 1;
      status.value = "write — a + b = c";
      yield* write(sym, 0.6);
      yield 0.3;

      status.value = "color — green tag the substitutables";
      sym.parts.a.color.value = GREEN;
      sym.parts.b.color.value = GREEN;
      sym.parts.c.color.value = GREEN;
      sub1.parts.a.color.value = GREEN;
      sub2.parts.a.color.value = GREEN;
      sub2.parts.b.color.value = GREEN;
      sub3.parts.a.color.value = GREEN;
      sub3.parts.b.color.value = GREEN;
      sub3.parts.c.color.value = GREEN;
      yield 0.5;

      status.value = "substitute — a → 2";
      yield* morph(sym, sub1, 0.55);
      yield 0.25;

      status.value = "substitute — b → 3";
      yield* morph(sub1, sub2, 0.55);
      yield 0.25;

      status.value = "substitute — c → 5";
      yield* morph(sub2, sub3, 0.55);
      yield 0.7;

      status.value = "morph — restore symbolic form (parallel rewrite)";
      yield* morph(sub3, sym, 0.7);
      yield 0.5;

      status.value = "writeOut";
      yield* writeOut(sym, 0.4);
      yield 0.4;
    });
  }
}
