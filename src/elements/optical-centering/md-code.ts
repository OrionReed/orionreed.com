// Combined code demo: a refactor cycle that exercises every shape of
// morph (inline edits, multi-line restructure, line moves), interleaved
// with token-level animation primitives (highlight / pluck / underline
// / cascade). One diagram, one cycle.
//
// The helpers (findRange, highlight, pluck, unpluck) are still parked
// here while the surface settles — natural promotion targets for
// `CodeShape` once we know what we want them to look like.

import {Anchor, Diagram, Mount, css, effect, label, loop, num, signal, vec, type Content} from "../../minim";
import {code, codeStyles, type CodeShape} from "../../minim/code";

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
  //    collapses to a one-line `yield* drive(...)`. Big multi-line
  //    restructure with implicit moves (let/while/dt/t all relocate
  //    into the new `drive` body).
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
  // 3. Lift `let t = 0;` out of drive to top level. Clean line-move:
  //    same trimmed text, different position, with the indent shrink
  //    riding as an inline edit within the moving line.
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

/** First Range in `wrapper` matching `text`. Walks descendant text
 *  nodes in tree order and returns a Range scoped to one node. */
function findRange(wrapper: HTMLElement, text: string | RegExp): Range | null {
  const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const content = node.textContent ?? "";
    let idx = -1;
    let len = 0;
    if (typeof text === "string") {
      idx = content.indexOf(text);
      len = text.length;
    } else {
      const m = text.exec(content);
      if (m) {
        idx = m.index;
        len = m[0].length;
      }
    }
    if (idx >= 0) {
      const r = new Range();
      r.setStart(node, idx);
      r.setEnd(node, idx + len);
      return r;
    }
    node = walker.nextNode() as Text | null;
  }
  return null;
}

/** Add `range` to the named Custom Highlight; returns a disposer. */
function highlight(range: Range, name: string): () => void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return () => {};
  let h = CSS.highlights.get(name);
  if (!h) {
    h = new Highlight();
    CSS.highlights.set(name, h);
  }
  h.add(range);
  return () => h?.delete(range);
}

/** Wrap a Range in an inline-block span so its transform can animate
 *  independently of surrounding flow. Re-paints highlights so the
 *  surrounding (and wrapped) text reattaches its colour against the
 *  freshly-split text nodes. */
function pluck(c: CodeShape, range: Range, className: string): HTMLSpanElement | null {
  try {
    const span = document.createElement("span");
    span.className = className;
    range.surroundContents(span);
    c._repaintHighlights();
    return span;
  } catch {
    return null;
  }
}

/** Inverse of `pluck`: dissolve the wrapping span, normalise adjacent
 *  text nodes, repaint highlights. */
function unpluck(c: CodeShape, span: HTMLSpanElement): void {
  const parent = span.parentNode;
  if (!parent) return;
  while (span.firstChild) parent.insertBefore(span.firstChild, span);
  parent.removeChild(span);
  parent.normalize();
  c._repaintHighlights();
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
    .minim-code-plucked {
      display: inline-block;
      transform-origin: center bottom;
      will-change: transform;
    }
  `;

  protected scene(s: Mount): void {
    const view = this.view(680, 400);

    const status = signal<Content>("");

    s(
      label(view.top.down(20), "code — morph + token animation", {
        size: 12,
        opacity: 0.55,
        align: Anchor.Center,
      }),
      label(view.bottom.up(20), status, {
        size: 11,
        opacity: 0.5,
        align: Anchor.Center,
      }),
    );

    const c = s(code(STATES[0], {size: 13}));
    // Top-left anchored: both edges fixed so neither vertical nor
    // horizontal layout jitters as content grows / collapses.
    const LEFT_X = 40;
    const TOP_Y = 48;
    c.translate.bind(() => vec(LEFT_X, TOP_Y).value);

    const wrapper = c.wrapper;
    this.anim.start(
      loop(function* () {
        yield 1.0;

        // ---- Token animations on state 1 ----
        status.value = "highlight — flash background on a token";
        yield 0.4;
        for (const txt of ["opacity", "secs"]) {
          const r = findRange(wrapper, txt);
          if (!r) continue;
          const dispose = highlight(r, PULSE);
          yield 0.4;
          dispose();
          yield 0.15;
        }
        yield 0.5;

        status.value = "pluck — wrap, transform, restore";
        yield 0.4;
        const yieldRange = findRange(wrapper, "yield");
        if (yieldRange) {
          const span = pluck(c, yieldRange, "minim-code-plucked");
          if (span) {
            const ty = num(0);
            const rot = num(0);
            const stop = effect(() => {
              span.style.transform =
                `translateY(${ty.value}px) rotate(${rot.value}rad)`;
            });
            yield [ty.to(-10, 0.25), rot.to(0.18, 0.25)];
            yield 0.6;
            yield [ty.to(0, 0.25), rot.to(0, 0.25)];
            stop();
            unpluck(c, span);
          }
        }
        yield 0.5;

        // ---- Morph 1 → 2: extract loop generator (body collapses) ----
        status.value = "morph — extract a loop generator (body collapses to one line)";
        yield* c.morphTo(STATES[1], 0.9);
        yield 0.8;

        status.value = "underline — persistent decoration";
        yield 0.4;
        const callRange = findRange(wrapper, "yield* drive");
        if (callRange) {
          const dispose = highlight(callRange, UNDERLINE);
          yield 1.0;
          dispose();
        }
        yield 0.5;

        // ---- Morph 2 → 3: lift `let t = 0;` (clean line move) ----
        status.value = "morph — lift `let t = 0` out (line moves, indent shrinks inline)";
        yield* c.morphTo(STATES[2], 0.9);
        yield 0.8;

        status.value = "cascade — sequence of highlights";
        yield 0.4;
        for (const txt of ["let t = 0", "t < dur", "t += dt", "step(t / dur)"]) {
          const r = findRange(wrapper, txt);
          if (!r) continue;
          const dispose = highlight(r, PULSE);
          yield 0.35;
          dispose();
          yield 0.05;
        }
        yield 0.8;

        // ---- Morph 3 → 1: back to the start ----
        status.value = "morph — back to the start";
        yield* c.morphTo(STATES[0], 0.9);
        yield 0.8;
      }),
    );
  }
}
