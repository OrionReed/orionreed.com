// Surgical-cut morph for CodeShape.
//
// Default state of a CodeShape: the wrapper contains pure text — no
// spans, no DOM mutation for syntax. At morph time we compute a
// token-level diff against the target, then surgically replace the
// wrapper's text with a sequence of `(text-node | del-span | ins-span)`
// children matching the diff. The visible content at this moment
// equals the OLD source (deletes at natural width, inserts at width 0).
//
// During the morph each delete-span animates `width: natural → 0` and
// each insert-span animates `width: 0 → natural`. Surrounding text and
// matched spans stay in normal flow; they reflow naturally as the
// in-flow spans change width. No `position: absolute`, no per-token
// position interpolation — the browser's text layout does all the
// "trailing tokens slide" work for free.
//
// At completion we wipe innerHTML back to plain text. No visual jump
// because the spans were already at the natural new-state widths.
//
// Diff: token-level LCS. Tokens come from `tokenize.ts` (Prism). Each
// token's `(type, text)` pair is the matching key; the LCS aligns
// equal-type-and-text tokens between the two streams. Multiple matches
// for the same token text find their correct alignment via the LCS —
// the previous occurrence-index heuristic would mismatch a deleted `t`
// with a kept `t` from a different position.

import {drive, easeInOut, type Animator, type Easing} from "@minim/core";
import {tokenize, type Token} from "./tokenize";
import type {CodeShape} from "./code";

// ── Diff ────────────────────────────────────────────────────────────

interface MatchOp {readonly type: "match"; readonly text: string}
interface DeleteOp {readonly type: "delete"; readonly text: string}
interface InsertOp {readonly type: "insert"; readonly text: string}
type Op = MatchOp | DeleteOp | InsertOp;

/** Token-level LCS diff. Output is a sequence of ops in walking order:
 *  matches advance both streams, deletes advance old, inserts advance
 *  new. Concatenating match.text + delete.text reconstructs old;
 *  concatenating match.text + insert.text reconstructs new. */
function diff(oldToks: readonly Token[], newToks: readonly Token[]): Op[] {
  const m = oldToks.length;
  const n = newToks.length;
  const eq = (a: Token, b: Token): boolean => a.type === b.type && a.text === b.text;

  // dp[i][j] = LCS length of oldToks[i..] and newToks[j..]. Filled
  // from the bottom-right corner so we can read off the alignment by
  // walking forward from (0, 0).
  const dp: number[][] = Array.from({length: m + 1}, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (eq(oldToks[i], newToks[j])) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk forward, emitting ops. At each (i, j) prefer match when the
  // tokens agree; otherwise pick the direction that retains the
  // longer remaining LCS.
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (eq(oldToks[i], newToks[j])) {
      ops.push({type: "match", text: oldToks[i].text});
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({type: "delete", text: oldToks[i].text});
      i++;
    } else {
      ops.push({type: "insert", text: newToks[j].text});
      j++;
    }
  }
  while (i < m) ops.push({type: "delete", text: oldToks[i++].text});
  while (j < n) ops.push({type: "insert", text: newToks[j++].text});
  return ops;
}

// ── Surgical cut + animation ────────────────────────────────────────

interface AnimSpan {
  /** The live span element in the wrapper. */
  el: HTMLSpanElement;
  /** Natural rendered width in CSS pixels. */
  naturalWidth: number;
  /** Natural rendered height in CSS pixels. */
  naturalHeight: number;
  /** True iff the span's content contains a newline — i.e. it's a
   *  multi-line edit. Width-only animation is right for inline edits
   *  (the span sits on a single line with other content, and that
   *  content sets the line height). For multi-line edits the span is
   *  on a line by itself (or its content drives line height), so we
   *  animate height too — collapses to zero on delete, grows from zero
   *  on insert, so the surrounding lines reflow vertically. */
  multiLine: boolean;
}

/** Build the morph DOM inside the wrapper: a sequence of (text node |
 *  delete span | insert span) matching `ops`. Returns the spans
 *  separately so the drive loop can animate their widths. Insert
 *  spans start at full natural width here so we can measure them;
 *  the caller collapses them to 0 before the drive loop starts. */
function buildMorphDOM(
  wrapper: HTMLDivElement,
  ops: readonly Op[],
): {deletes: AnimSpan[]; inserts: AnimSpan[]} {
  // Wipe wrapper first. textContent = "" is faster than innerHTML = "".
  while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);

  const deletes: HTMLSpanElement[] = [];
  const inserts: HTMLSpanElement[] = [];

  // Coalesce adjacent same-type ops to reduce span count. Matches
  // stay as plain text nodes; consecutive deletes/inserts collapse
  // into one span. Visually equivalent, cheaper to animate.
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === "match") {
      // Run of matches → one text node.
      let text = "";
      while (i < ops.length && ops[i].type === "match") {
        text += ops[i].text;
        i++;
      }
      wrapper.appendChild(document.createTextNode(text));
      continue;
    }
    // Run of deletes / inserts → one span each. We don't merge
    // delete+insert into a single "replace" span yet — keeping them
    // separate gives the natural-reflow crossfade where the delete
    // shrinks and the insert grows in the same horizontal slot.
    if (op.type === "delete") {
      let text = "";
      while (i < ops.length && ops[i].type === "delete") {
        text += ops[i].text;
        i++;
      }
      const span = makeAnimSpan(text, "minim-code-del");
      wrapper.appendChild(span);
      deletes.push(span);
      continue;
    }
    // insert
    let text = "";
    while (i < ops.length && ops[i].type === "insert") {
      text += ops[i].text;
      i++;
    }
    const span = makeAnimSpan(text, "minim-code-ins");
    wrapper.appendChild(span);
    inserts.push(span);
  }

  // Measure natural widths + heights AFTER mounting so layout is
  // final. One forced reflow per measurement loop.
  const snap = (el: HTMLSpanElement): AnimSpan => ({
    el,
    naturalWidth: el.offsetWidth,
    naturalHeight: el.offsetHeight,
    multiLine: (el.textContent ?? "").includes("\n"),
  });
  const delAnimSpans: AnimSpan[] = deletes.map(snap);
  const insAnimSpans: AnimSpan[] = inserts.map(snap);

  return {deletes: delAnimSpans, inserts: insAnimSpans};
}

/** Construct an inline-block span that can shrink below its content's
 *  natural width without visually escaping. We deliberately AVOID
 *  `overflow: hidden` here: per the CSS spec, an inline-block whose
 *  `overflow` is anything other than `visible` has its baseline set to
 *  the bottom margin edge, which makes the line box taller while the
 *  spans exist (then shorter when morph commits and spans are removed).
 *  The visible symptom is content "popping up" at morph end — lines
 *  below shift upward as the line box shrinks back. `clip-path` clips
 *  visually without touching baseline, and follows the box as its
 *  width animates. `white-space: pre` keeps newlines + indent intact;
 *  `vertical-align: baseline` is explicit as a guard. */
function makeAnimSpan(text: string, className: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  span.style.display = "inline-block";
  span.style.overflow = "visible";
  span.style.clipPath = "inset(0 0 0 0)";
  span.style.whiteSpace = "pre";
  span.style.verticalAlign = "baseline";
  return span;
}

// ── Public entry ────────────────────────────────────────────────────

/** Animate `code` from its current source to `target` via token-level
 *  diff + surgical-cut morph. Yields when the transition completes.
 *  Cancel-safe: the `finally` block commits the final state. */
export function* morph(
  code: CodeShape,
  target: string,
  dur: number,
  ease: Easing = easeInOut,
): Animator<void> {
  const oldSrc = code.source.peek();
  if (oldSrc === target) return;

  const ops = diff(
    tokenize(oldSrc, code.language),
    tokenize(target, code.language),
  );

  // Wipe syntax-highlight Ranges before we restructure the wrapper —
  // the Ranges point into the current text node which is about to be
  // replaced. `_setSourceAndRender` re-paints at the end.
  code._clearHighlights();

  const {deletes, inserts} = buildMorphDOM(code.wrapper, ops);

  // Collapse insert spans to their start state BEFORE the first paint.
  // Multi-line inserts also start at height 0 so the surrounding lines
  // sit flush; growing height pushes them apart.
  for (const ins of inserts) {
    ins.el.style.width = "0px";
    ins.el.style.opacity = "0";
    if (ins.multiLine) ins.el.style.height = "0px";
  }
  // Multi-line deletes need an explicit height to start. Auto-height
  // would track content as we shrink; pinning natural lets the
  // animation lerp cleanly.
  for (const del of deletes) {
    if (del.multiLine) del.el.style.height = del.naturalHeight + "px";
  }

  try {
    yield* drive((_dt, t) => {
      const u = Math.min(1, t / dur);
      const e = ease(u);

      for (const del of deletes) {
        del.el.style.width = del.naturalWidth * (1 - e) + "px";
        if (del.multiLine) del.el.style.height = del.naturalHeight * (1 - e) + "px";
        del.el.style.opacity = String(1 - e);
      }
      for (const ins of inserts) {
        ins.el.style.width = ins.naturalWidth * e + "px";
        if (ins.multiLine) ins.el.style.height = ins.naturalHeight * e + "px";
        ins.el.style.opacity = String(e);
      }

      // The wrapper's natural inline-block width follows its content,
      // which is now changing every frame. Push that into the size
      // signals so outer layout (centring, etc.) tracks smoothly.
      // Reading offsetWidth forces a per-frame reflow, but the spans
      // change anyway — no incremental cost.
      const nw = code.wrapper.offsetWidth;
      const nh = code.wrapper.offsetHeight;
      if (nw !== code.width.peek()) code.width.value = nw;
      if (nh !== code.height.peek()) code.height.value = nh;

      if (u >= 1) return false;
    });
  } finally {
    // Wipe back to plain text. At t=1 the spans were already at their
    // natural new-state widths, so visually the wrapper looks like
    // the natural new layout — no jump on the final swap.
    code._setSourceAndRender(target);
  }
}
