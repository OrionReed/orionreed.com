// Combined code demo on the new monospace substrate.
//
//   - `c.parts` is the flat list of parts; each part is a single-line
//     positioned span with `.position` (Vec) and `.opacity`/`.rotation`
//     (Num) signals. Animations are just `.to(...)` calls.
//   - `c.cut(part, [offsets])` carves a sub-region into its own part;
//     `c.uncut([parts])` merges contiguous parts back. Pluck/wiggle is
//     "cut, animate, uncut".
//   - Background highlight + wavy underline still use CSS Custom
//     Highlights; the substrate's `paint()` doesn't touch their buckets
//     so they survive any repaints.
//   - Morph animates parts directly (per-line cross-fade + position
//     tween on Kept lines; opacity fades for Lost/Gained); there's no
//     drive loop or DOM rebuild.

import { bind, type Content, css, Diagram, label, loop, Mount, signal, vec } from "../../minim";
import { type CodeShape, code, codeStyles, Part } from "../../minim/code";

const STATES = [
  // 1. Inline original.
  `function* fadeOut(opacity, secs) {
  let t = 0;
  while (t < secs) {
    const dt = yield;
    t += dt;
    opacity.value = 1 - t / secs;
  }
}`,
  // 2. Extract a loop generator — drive opens up above, fadeOut
  //    collapses to a one-line `yield* drive(...)`.
  `function* drive(dur, step) {
  let t = 0;
  while (t < dur) {
    const dt = yield;
    t += dt;
    step(t / dur);
  }
}

function* fadeOut(opacity, secs) {
  yield* drive(secs, u => opacity.value = 1 - u);
}`,
  // 3. Lift `let t = 0;` out of drive — clean line-move with indent
  //    shrink. Both the line-level and indent changes are handled by
  //    the same per-line morph machinery.
  `let t = 0;

function* drive(dur, step) {
  while (t < dur) {
    const dt = yield;
    t += dt;
    step(t / dur);
  }
}

function* fadeOut(opacity, secs) {
  yield* drive(secs, u => opacity.value = 1 - u);
}`,
];

const PULSE = "minim-code-pulse";
const UNDERLINE = "minim-code-underline";

/** Find the first part containing `text`. Returns the part plus the
 *  start/end character offsets within its text, or null. */
function findInCode(c: CodeShape, text: string): { part: Part; start: number; end: number } | null {
  for (const p of c.parts) {
    const i = p.text.indexOf(text);
    if (i >= 0) return { part: p, start: i, end: i + text.length };
  }
  return null;
}

/** Add a Range over `[start, end)` chars of the part's text node to
 *  the named Custom Highlight. Returns a disposer. */
function highlightRange(part: Part, start: number, end: number, name: string): () => void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return () => {};
  const tn = part.el.firstChild;
  if (!tn || tn.nodeType !== Node.TEXT_NODE) return () => {};
  const r = new Range();
  try {
    r.setStart(tn as Text, start);
    r.setEnd(tn as Text, end);
  } catch {
    return () => {};
  }
  let h = CSS.highlights.get(name);
  if (!h) {
    h = new Highlight();
    CSS.highlights.set(name, h);
  }
  h.add(r);
  return () => h?.delete(r);
}

export class MdCode extends Diagram {
  static styles = css`
    ${codeStyles}

    ::highlight(${PULSE}) {
      background: rgba(255, 220, 80, 0.55);
      border-radius: 2px;
    }
    ::highlight(${UNDERLINE}) {
      text-decoration: underline wavy var(--prettylights-keyword, #cf222e);
      text-decoration-thickness: 1.5px;
    }
  `;

  protected scene(s: Mount): void {
    const view = this.view(680, 400);

    const status = signal<Content>("");

    s(
      label(view.top.down(20), "code — morph + token animation"),
      label(view.bottom.up(20), status),
    );

    const c = s(code(STATES[0], { size: 13 }));
    // Top-left anchored.
    const LEFT_X = 40;
    const TOP_Y = 48;
    bind(c.translate, () => vec(LEFT_X, TOP_Y).value);

    this.anim.start(
      loop(function* () {
        yield 1.0;

        // 1. Highlight — flash background on a token via Custom Highlight.
        status.value = "highlight — flash background on a token";
        yield 0.4;
        for (const txt of ["opacity", "secs"]) {
          const found = findInCode(c, txt);
          if (!found) continue;
          const dispose = highlightRange(found.part, found.start, found.end, PULSE);
          yield 0.4;
          dispose();
          yield 0.15;
        }
        yield 0.5;

        // 2. Pluck — cut the token out into its own part, animate, uncut.
        status.value = "pluck — cut, animate, uncut";
        yield 0.4;
        const yieldFound = findInCode(c, "yield");
        if (yieldFound) {
          const subs = c.cut(yieldFound.part, [yieldFound.start, yieldFound.end]);
          const middle = yieldFound.start > 0 ? subs[1] : subs[0];
          const home = middle.position.peek();
          yield [
            middle.position.to({ x: home.x, y: home.y - 10 }, 0.25),
            middle.rotation.to(0.18, 0.25),
          ];
          yield 0.6;
          yield [middle.position.to(home, 0.25), middle.rotation.to(0, 0.25)];
          c.uncut(subs);
        }
        yield 0.5;

        // Morph 1 → 2.
        status.value = "morph — extract a loop generator (body collapses to one line)";
        yield* c.morphTo(STATES[1], 0.9);
        yield 0.8;

        // 3. Underline — persistent decoration over a span of text.
        status.value = "underline — persistent decoration";
        yield 0.4;
        const callFound = findInCode(c, "yield* drive");
        if (callFound) {
          const dispose = highlightRange(callFound.part, callFound.start, callFound.end, UNDERLINE);
          yield 1.0;
          dispose();
        }
        yield 0.5;

        // Morph 2 → 3: clean line move (let t = 0) + indent change.
        status.value = "morph — lift `let t = 0` out (line moves, indent shrinks)";
        yield* c.morphTo(STATES[2], 0.9);
        yield 0.8;

        // 4. Cascade — sequence of highlights.
        status.value = "cascade — sequence of highlights";
        yield 0.4;
        for (const txt of ["let t = 0", "t < dur", "t += dt", "step(t / dur)"]) {
          const found = findInCode(c, txt);
          if (!found) continue;
          const dispose = highlightRange(found.part, found.start, found.end, PULSE);
          yield 0.35;
          dispose();
          yield 0.05;
        }
        yield 0.8;

        // Morph 3 → 1.
        status.value = "morph — back to the start";
        yield* c.morphTo(STATES[0], 0.9);
        yield 0.8;
      }),
    );
  }
}
