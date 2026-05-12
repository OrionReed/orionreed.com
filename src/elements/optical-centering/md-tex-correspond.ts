// minim/tex correspondence demo: identity across structurally
// distinct representations.
//
//   1↔N (fan-out)  ─── one symbol corresponds to many: \vec{v} ↔
//                      (v_x, v_y, v_z), \sum a_i ↔ a_1 + a_2 + a_3.
//                      Authoring: marker.expand({...}).
//
//   substitution  ─── same identity, different content: a + b = c
//                      → 2 + 3 = 5 via marker.with(newContent).
//
// Color is set on markers (not Parts) and cascades through the
// expand chain — `tint(BLUE, ai)` colors a_i, a_1, a_2, a_3
// together.

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
  tint,
  write,
  writeOut,
  type Content,
} from "../../minim";

const RED = "#e25c5c";
const BLUE = "#5b8def";
const GREEN = "#3aa56b";

// Extracted as JS-string constants — avoids Cursor's TS grammar
// trip on `_{i=…}` patterns inside template literals.
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

    // ── A: vector ↔ components (1↔3 via expand) ───────────────────
    const v = part("v", VEC_V);
    const { vx, vy, vz } = v.expand({ vx: "v_x", vy: "v_y", vz: "v_z" });
    const vSym = s(tex`${v}`);
    const vComp = s(tex`(${vx}, ${vy}, ${vz})`);

    // ── B: sum ↔ expansion (1↔3 via expand) ───────────────────────
    const ai = part("ai", "a_i");
    const { a1, a2, a3 } = ai.expand({ a1: "a_1", a2: "a_2", a3: "a_3" });
    const sigma = s(tex`${SUM_RANGE} ${ai}`);
    const flat = s(tex`${a1} + ${a2} + ${a3}`);

    // ── C: concrete numbers (staggered substitution via .with) ────
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

    // Snapshot the identity-root markers' colors — color cascades
    // from these via the expand chain, so capturing the roots
    // resets every derived child too.
    const reset = snapshot(
      ...eqs.map((eq) => eq.opacity),
      v.color,
      ai.color,
      a.color,
      b.color,
      c.color,
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

      status.value = "color — tag v's identity (cascades to vx, vy, vz)";
      tint(RED, v); // colors v AND vx, vy, vz via cascade
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

      status.value = "color — body a_i (cascades to a_1, a_2, a_3)";
      tint(BLUE, ai);
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
      // a, b, c are independent identities (no shared root) so we
      // tint all three. `.with("2")` children inherit via group.
      tint(GREEN, a, b, c);
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
