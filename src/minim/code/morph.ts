// Line-aware morph for CodeShape.
//
// Two granularities of diff:
//
//   1. Line-level LCS over the source split by '\n'. Identical lines
//      are matched and stay put. Adjacent (delete, insert) pairs are
//      treated as MODIFY ops (the line's text changed).
//   2. For each MODIFY op, a token-level LCS within the line: matched
//      tokens stay as text, edits become inline-block spans whose
//      widths animate (delete shrinks, insert grows).
//
// Each line lives in its own `<span class="minim-code-line">` element
// (display: block), so:
//
//   - PURE inserts: a brand-new line element is created at height 0,
//     animates up to its natural line-height. Surrounding lines reflow
//     vertically.
//   - PURE deletes: the existing line element's height animates to 0,
//     then it's removed at morph commit.
//   - MODIFY: the line element's children get the inline morph
//     treatment — text + width-animating spans.
//
// No multi-line inline-block spans anywhere — the structural newlines
// are always between line elements, not inside them. That avoids the
// baseline-deformation issue an inline-block with internal newlines
// triggers (per CSS spec, its baseline lands at the bottom margin
// edge, distorting surrounding layout).

import {drive, easeInOut, type Animator, type Easing} from "@minim/core";
import {LINE_CLASS, makeLineEl, type CodeShape} from "./code";
import {tokenize, type Token} from "./tokenize";

// ── Token-level diff (used inside MODIFY ops) ───────────────────────
//
// Each op carries the underlying `Token` (with its type, from the
// full-source tokenization). That's what later lets us paint correct
// syntax-colour highlights on morph spans without re-tokenizing
// fragments — a context-free re-tokenize of e.g. `lerp` alone would
// lose the "function" classification since Prism keys off the
// following `(`. The token we got from the full line already has the
// right type; we just need to keep it.

interface MatchOp {readonly type: "match"; readonly text: string; readonly tokens: readonly Token[]}
interface DeleteOp {readonly type: "delete"; readonly text: string; readonly tokens: readonly Token[]}
interface InsertOp {readonly type: "insert"; readonly text: string; readonly tokens: readonly Token[]}
type Op = MatchOp | DeleteOp | InsertOp;

function diffTokens(oldToks: readonly Token[], newToks: readonly Token[]): Op[] {
  const m = oldToks.length;
  const n = newToks.length;
  const eq = (a: Token, b: Token): boolean => a.type === b.type && a.text === b.text;

  const dp: number[][] = Array.from({length: m + 1}, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (eq(oldToks[i], newToks[j])) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (eq(oldToks[i], newToks[j])) {
      ops.push({type: "match", text: oldToks[i].text, tokens: [oldToks[i]]});
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({type: "delete", text: oldToks[i].text, tokens: [oldToks[i]]});
      i++;
    } else {
      ops.push({type: "insert", text: newToks[j].text, tokens: [newToks[j]]});
      j++;
    }
  }
  while (i < m) {
    const t = oldToks[i++];
    ops.push({type: "delete", text: t.text, tokens: [t]});
  }
  while (j < n) {
    const t = newToks[j++];
    ops.push({type: "insert", text: t.text, tokens: [t]});
  }
  return ops;
}

// ── Line-level diff ─────────────────────────────────────────────────

interface LineMatch {readonly type: "match"; readonly oldIdx: number; readonly newIdx: number}
interface LineDelete {readonly type: "delete"; readonly oldIdx: number}
interface LineInsert {readonly type: "insert"; readonly newIdx: number}
type LineOp = LineMatch | LineDelete | LineInsert;

function diffLines(oldLines: readonly string[], newLines: readonly string[]): LineOp[] {
  // FUZZY equality: lines whose content matches after stripping leading
  // whitespace are considered "the same line at a different indent".
  // This lets us follow a line as it moves from inside a function to
  // outside (or vice versa) — the line stays put as a match, and the
  // indent change is handled as an inline edit within the line.
  // Without this, the line would be treated as delete+insert and fade
  // out + reappear elsewhere rather than visibly moving.
  const eq = (a: string, b: string): boolean => a.trimStart() === b.trimStart();
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({length: m + 1}, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (eq(oldLines[i], newLines[j])) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (eq(oldLines[i], newLines[j])) {
      ops.push({type: "match", oldIdx: i, newIdx: j});
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({type: "delete", oldIdx: i});
      i++;
    } else {
      ops.push({type: "insert", newIdx: j});
      j++;
    }
  }
  while (i < m) ops.push({type: "delete", oldIdx: i++});
  while (j < n) ops.push({type: "insert", newIdx: j++});
  return ops;
}

/** Pair adjacent (delete, insert) op pairs as MODIFY — the old line was
 *  changed in place rather than removed and a new one appearing.
 *  Without this, an inline edit like `opacity → sig` would shrink the
 *  whole line and grow a new one; with it, the line stays put and only
 *  the changed tokens within crossfade.
 *
 *  MOVE is the cross-position version: same trimmed content in both
 *  sources but at different LCS-walk positions (i.e. the line was
 *  lifted from inside a function to outside, or two declarations
 *  swapped). Detected POST-LCS by `detectMoves` below — it pairs any
 *  remaining (delete X, insert Y) where X.trimStart() === Y.trimStart()
 *  into a single MOVE op, which the morph then renders as one DOM
 *  element with a `transform: translate(...)` that animates from the
 *  old position to the new. */
type LineOpResolved =
  | {readonly kind: "match"; readonly oldIdx: number; readonly newIdx: number}
  | {readonly kind: "modify"; readonly oldIdx: number; readonly newIdx: number}
  | {readonly kind: "delete"; readonly oldIdx: number}
  | {readonly kind: "insert"; readonly newIdx: number}
  | {readonly kind: "move"; readonly oldIdx: number; readonly newIdx: number};

/** Scan an already-resolved op list and convert any remaining
 *  (delete X, insert Y) pairs with same trimmed text into MOVE ops.
 *  Walks: collects deletes by trimmed text first; then for each insert,
 *  pops the matching delete from the bucket and emits a MOVE; the
 *  original delete is dropped. The MOVE keeps its position in the ops
 *  list (the insert's walk position, which corresponds to the new
 *  line's order in the wrapper). */
function detectMoves(
  ops: readonly LineOpResolved[],
  oldLines: readonly string[],
  newLines: readonly string[],
): LineOpResolved[] {
  // PASS 1: bucket delete-op old indices by their trimmed text.
  const deleteByText: Map<string, number[]> = new Map();
  for (const op of ops) {
    if (op.kind !== "delete") continue;
    const t = oldLines[op.oldIdx].trimStart();
    if (t === "") continue; // empty lines are too ambiguous to pair
    const arr = deleteByText.get(t);
    if (arr) arr.push(op.oldIdx);
    else deleteByText.set(t, [op.oldIdx]);
  }

  // PASS 2: pair each insert with a delete (if any) of the same trimmed
  // text; track which old indices got consumed.
  const movePairs = new Map<number, number>(); // insert.newIdx → delete.oldIdx
  for (const op of ops) {
    if (op.kind !== "insert") continue;
    const t = newLines[op.newIdx].trimStart();
    if (t === "") continue;
    const bucket = deleteByText.get(t);
    if (!bucket || bucket.length === 0) continue;
    const oldIdx = bucket.shift()!;
    movePairs.set(op.newIdx, oldIdx);
  }

  if (movePairs.size === 0) return ops as LineOpResolved[];

  // PASS 3: rebuild. Drop paired deletes; swap paired inserts for MOVE.
  const consumedDeletes = new Set<number>(movePairs.values());
  const out: LineOpResolved[] = [];
  for (const op of ops) {
    if (op.kind === "delete" && consumedDeletes.has(op.oldIdx)) continue;
    if (op.kind === "insert" && movePairs.has(op.newIdx)) {
      out.push({kind: "move", oldIdx: movePairs.get(op.newIdx)!, newIdx: op.newIdx});
      continue;
    }
    out.push(op);
  }
  return out;
}

function pairModifications(
  ops: readonly LineOp[],
  oldLines: readonly string[],
  newLines: readonly string[],
): LineOpResolved[] {
  const out: LineOpResolved[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === "match") {
      // Fuzzy match: raw lines differ only in leading whitespace.
      // Treat as a modification so the inline diff handles the indent
      // change — the line stays in place (matched) while its indent
      // animates as an inline delete/insert.
      if (oldLines[op.oldIdx] !== newLines[op.newIdx]) {
        out.push({kind: "modify", oldIdx: op.oldIdx, newIdx: op.newIdx});
      } else {
        out.push({kind: "match", oldIdx: op.oldIdx, newIdx: op.newIdx});
      }
      i++;
      continue;
    }
    if (op.type === "delete" && i + 1 < ops.length && ops[i + 1].type === "insert") {
      const ins = ops[i + 1] as LineInsert;
      out.push({kind: "modify", oldIdx: op.oldIdx, newIdx: ins.newIdx});
      i += 2;
      continue;
    }
    if (op.type === "delete") {
      out.push({kind: "delete", oldIdx: op.oldIdx});
      i++;
      continue;
    }
    out.push({kind: "insert", newIdx: op.newIdx});
    i++;
  }
  return out;
}

// ── Animatable element bundles ──────────────────────────────────────

interface InlineAnim {
  el: HTMLSpanElement;
  naturalWidth: number;
}

interface LineAnim {
  el: HTMLSpanElement;
  naturalHeight: number;
  naturalWidth: number;
}

/** Lines that need to animate their visual POSITION (matches, moves,
 *  and even deletes whose old visual position differs from their
 *  t=0 flow position). `oldX` / `oldY` are captured from the old
 *  wrapper layout before the morph starts; `dx` / `dy` are computed
 *  AFTER `buildLineMorph` + insert initialisation, by reading the
 *  element's flow position at t=0 and subtracting from old. The drive
 *  loop interpolates `transform: translate((1-e)·dx, (1-e)·dy)`. */
interface PositionAnim {
  el: HTMLSpanElement;
  oldX: number;
  oldY: number;
  dx: number;
  dy: number;
}

interface Animations {
  /** Whole-line collapses (width + height + opacity). */
  lineDeletes: LineAnim[];
  /** Whole-line emerges (width + height + opacity). */
  lineInserts: LineAnim[];
  /** Inline content shrinks within a MODIFY line (width + opacity). */
  inlineDeletes: InlineAnim[];
  /** Inline content grows within a MODIFY line (width + opacity). */
  inlineInserts: InlineAnim[];
  /** Per-line position transforms — applied to every match, move, and
   *  delete element so each interpolates smoothly from its OLD visual
   *  position to its NEW flow position. Inserts don't need this; they
   *  animate via height/width/opacity from (0, 0). */
  positions: PositionAnim[];
}

// ── Building the morph DOM ──────────────────────────────────────────

/** Construct an inline-block span that can shrink below its content's
 *  natural width via `clip-path`. We use `overflow: visible` (NOT
 *  hidden) so the CSS-spec rule that bumps an inline-block's baseline
 *  to its bottom margin edge doesn't trigger. `clip-path: inset(0)`
 *  clips visually without touching baseline. */
function makeInlineSpan(text: string, className: string, tokens: readonly Token[]): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  span.style.display = "inline-block";
  span.style.overflow = "visible";
  span.style.clipPath = "inset(0 0 0 0)";
  span.style.whiteSpace = "pre";
  span.style.verticalAlign = "baseline";
  attachTokens(span, tokens);
  return span;
}

/** Construct a pure-inline wrapper around matched text — no styling,
 *  no animation — purely as a carrier for the matched-token type
 *  metadata so syntax-highlight painting can use the original
 *  full-source tokenization instead of re-tokenizing the fragment. */
function makeMatchedSpan(text: string, tokens: readonly Token[]): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "minim-code-match";
  span.textContent = text;
  attachTokens(span, tokens);
  return span;
}

/** Replace `lineEl`'s content with a sequence of spans matching the
 *  token-level diff. Three flavours of span:
 *
 *    .minim-code-match — passthrough text wrapper carrying token metadata
 *    .minim-code-del   — inline-block animating width: natural → 0
 *    .minim-code-ins   — inline-block animating width: 0 → natural
 *
 *  Each span carries its original-source `Token[]` via a WeakMap, so
 *  `CodeShape.#paintHighlights` can colour the inside using the
 *  full-context tokenization rather than re-tokenizing the fragment. */
function buildInlineMorph(lineEl: HTMLElement, ops: readonly Op[]): {
  deletes: HTMLSpanElement[];
  inserts: HTMLSpanElement[];
} {
  while (lineEl.firstChild) lineEl.removeChild(lineEl.firstChild);
  const deletes: HTMLSpanElement[] = [];
  const inserts: HTMLSpanElement[] = [];

  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === "match") {
      let text = "";
      const tokens: Token[] = [];
      while (i < ops.length && ops[i].type === "match") {
        text += ops[i].text;
        tokens.push(...ops[i].tokens);
        i++;
      }
      lineEl.appendChild(makeMatchedSpan(text, tokens));
      continue;
    }
    const type = op.type;
    let text = "";
    const tokens: Token[] = [];
    while (i < ops.length && ops[i].type === type) {
      text += ops[i].text;
      tokens.push(...ops[i].tokens);
      i++;
    }
    const className = type === "delete" ? "minim-code-del" : "minim-code-ins";
    const span = makeInlineSpan(text, className, tokens);
    lineEl.appendChild(span);
    (type === "delete" ? deletes : inserts).push(span);
  }
  return {deletes, inserts};
}

// ── Token attachment (off-DOM via WeakMap) ──────────────────────────
//
// We store the original tokens for each morph span out of band so the
// DOM stays uncluttered (no JSON-stuffed data attributes, no own
// properties on Element). `CodeShape.#paintHighlights` reads from
// `getAttachedTokens` to colour each span.

const tokenMap = new WeakMap<Element, readonly Token[]>();

function attachTokens(el: Element, tokens: readonly Token[]): void {
  tokenMap.set(el, tokens);
}

export function getAttachedTokens(el: Element): readonly Token[] | undefined {
  return tokenMap.get(el);
}

/** Rebuild the wrapper as a sequence of line elements matching the
 *  resolved line ops. Returns the elements that need animation.
 *  `positionTargets` tracks each line element that participates in
 *  position interpolation (everything except inserts) alongside its
 *  source `oldIdx` — the caller fills in `oldX/Y` from the pre-wipe
 *  capture and `dx/dy` once the t=0 layout has settled. */
function buildLineMorph(
  wrapper: HTMLElement,
  resolved: readonly LineOpResolved[],
  oldLines: readonly string[],
  newLines: readonly string[],
  language: string,
): {
  anim: Omit<Animations, "positions">;
  positionTargets: Array<{el: HTMLSpanElement; oldIdx: number}>;
} {
  // Tear down old line elements.
  while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);

  const lineDeletes: HTMLSpanElement[] = [];
  const lineInserts: HTMLSpanElement[] = [];
  const inlineDeletes: HTMLSpanElement[] = [];
  const inlineInserts: HTMLSpanElement[] = [];
  const positionTargets: Array<{el: HTMLSpanElement; oldIdx: number}> = [];

  for (const op of resolved) {
    if (op.kind === "match") {
      const lineEl = makeLineEl(newLines[op.newIdx]);
      wrapper.appendChild(lineEl);
      positionTargets.push({el: lineEl, oldIdx: op.oldIdx});
    } else if (op.kind === "modify" || op.kind === "move") {
      // MODIFY and MOVE share the same DOM treatment: one line element
      // starting with OLD text, with inline-morph spans that animate
      // the token-level changes to NEW text (handles content edits
      // like indent additions/removals), plus a position transform
      // that animates from the old visual position to the new flow
      // position. They differ only in whether the underlying
      // delete/insert pair was adjacent in the LCS walk (MODIFY) or
      // cross-position (MOVE — detected by `detectMoves`).
      const lineEl = makeLineEl(oldLines[op.oldIdx]); // start at old text
      wrapper.appendChild(lineEl);
      const ops = diffTokens(
        tokenize(oldLines[op.oldIdx], language),
        tokenize(newLines[op.newIdx], language),
      );
      const {deletes, inserts} = buildInlineMorph(lineEl, ops);
      inlineDeletes.push(...deletes);
      inlineInserts.push(...inserts);
      positionTargets.push({el: lineEl, oldIdx: op.oldIdx});
    } else if (op.kind === "delete") {
      const lineEl = makeLineEl(oldLines[op.oldIdx]);
      lineEl.style.overflow = "hidden";
      wrapper.appendChild(lineEl);
      lineDeletes.push(lineEl);
      positionTargets.push({el: lineEl, oldIdx: op.oldIdx});
    } else {
      // insert: create new line element, mounted at natural size so
      // we can measure it, then collapsed to (0, 0) just before drive.
      // Inserts don't get position transforms — they grow from (0, 0)
      // at their NEW flow position via height/width/opacity animation.
      const lineEl = makeLineEl(newLines[op.newIdx]);
      lineEl.style.overflow = "hidden";
      wrapper.appendChild(lineEl);
      lineInserts.push(lineEl);
    }
  }

  // Measure naturals AFTER mounting and BEFORE overriding min-height.
  // Without the natural min-height, empty inserted lines report
  // offsetHeight = 0; with it, they report one line-height. We want
  // the latter so empty lines actually open up.
  const lineDelAnim: LineAnim[] = lineDeletes.map((el) => ({
    el,
    naturalHeight: el.offsetHeight,
    naturalWidth: el.offsetWidth,
  }));
  const lineInsAnim: LineAnim[] = lineInserts.map((el) => ({
    el,
    naturalHeight: el.offsetHeight,
    naturalWidth: el.offsetWidth,
  }));
  const inlineDelAnim: InlineAnim[] = inlineDeletes.map((el) => ({
    el,
    naturalWidth: el.offsetWidth,
  }));
  const inlineInsAnim: InlineAnim[] = inlineInserts.map((el) => ({
    el,
    naturalWidth: el.offsetWidth,
  }));

  // NOW override min-height on animating lines so they can collapse
  // below the natural line-height during the morph.
  for (const a of lineDelAnim) a.el.style.minHeight = "0";
  for (const a of lineInsAnim) a.el.style.minHeight = "0";

  return {
    anim: {
      lineDeletes: lineDelAnim,
      lineInserts: lineInsAnim,
      inlineDeletes: inlineDelAnim,
      inlineInserts: inlineInsAnim,
    },
    positionTargets,
  };
}

// ── Public entry ────────────────────────────────────────────────────

/** Animate `code` from its current source to `target`. Yields when the
 *  transition completes. Cancel-safe — `finally` commits the final
 *  state via `_setSourceAndRender`. */
export function* morph(
  code: CodeShape,
  target: string,
  dur: number,
  ease: Easing = easeInOut,
): Animator<void> {
  const oldSrc = code.source.peek();
  if (oldSrc === target) return;

  const oldLines = oldSrc.split("\n");
  const newLines = target.split("\n");

  // Capture OLD line positions BEFORE the wrapper is wiped — these
  // are the reference points for the per-line translate transforms
  // that make matches, moves, and deletes interpolate smoothly from
  // their old positions to their new ones, regardless of LCS ordering
  // choices.
  const oldLineEls = Array.from(
    code.wrapper.querySelectorAll<HTMLElement>(`.${LINE_CLASS}`),
  );
  const oldPositions: {x: number; y: number}[] = oldLineEls.map((el) => ({
    x: el.offsetLeft,
    y: el.offsetTop,
  }));

  const lineOps = diffLines(oldLines, newLines);
  const resolvedBase = pairModifications(lineOps, oldLines, newLines);
  // After modify-pairing, scan for cross-position delete/insert pairs
  // with same trimmed text and consolidate them into MOVE ops. Without
  // this, an "outside the function" → "inside the function" lift
  // becomes fade-out + fade-in instead of a sliding move.
  const resolved = detectMoves(resolvedBase, oldLines, newLines);

  const {anim: animBase, positionTargets} = buildLineMorph(
    code.wrapper,
    resolved,
    oldLines,
    newLines,
    code.language,
  );

  // Re-paint syntax highlights against the just-rebuilt line elements.
  code._repaintHighlights();

  // Initialise insert states BEFORE first paint, so t=0 visually
  // equals the old source. Whole-line inserts and deletes animate
  // BOTH width and height so wrapper.offsetWidth at the morph
  // boundaries equals what the wrapper will be at steady state.
  for (const a of animBase.lineInserts) {
    a.el.style.height = "0px";
    a.el.style.width = "0px";
    a.el.style.opacity = "0";
  }
  for (const a of animBase.inlineInserts) {
    a.el.style.width = "0px";
    a.el.style.opacity = "0";
  }
  for (const a of animBase.lineDeletes) {
    a.el.style.height = a.naturalHeight + "px";
    a.el.style.width = a.naturalWidth + "px";
  }

  // NOW the layout is at the t=0 state (deletes natural, inserts 0).
  // Capture each position-tracked element's flow(0) and derive the
  // delta from its old position. transform = (1-e)·delta animates from
  // old visual position at t=0 to new flow position at t=1.
  const positions: PositionAnim[] = positionTargets.map((p) => {
    const oldPos = oldPositions[p.oldIdx] ?? {x: 0, y: 0};
    const flowX = p.el.offsetLeft;
    const flowY = p.el.offsetTop;
    const dx = oldPos.x - flowX;
    const dy = oldPos.y - flowY;
    if (dx !== 0 || dy !== 0) {
      p.el.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    return {el: p.el, oldX: oldPos.x, oldY: oldPos.y, dx, dy};
  });
  const anim: Animations = {...animBase, positions};

  try {
    yield* drive((_tick, t) => {
      const u = Math.min(1, t / dur);
      const e = ease(u);

      for (const a of anim.lineDeletes) {
        a.el.style.height = a.naturalHeight * (1 - e) + "px";
        a.el.style.width = a.naturalWidth * (1 - e) + "px";
        a.el.style.opacity = String(1 - e);
      }
      for (const a of anim.lineInserts) {
        a.el.style.height = a.naturalHeight * e + "px";
        a.el.style.width = a.naturalWidth * e + "px";
        a.el.style.opacity = String(e);
      }
      for (const a of anim.inlineDeletes) {
        a.el.style.width = a.naturalWidth * (1 - e) + "px";
        a.el.style.opacity = String(1 - e);
      }
      for (const a of anim.inlineInserts) {
        a.el.style.width = a.naturalWidth * e + "px";
        a.el.style.opacity = String(e);
      }
      // Position transforms: animate every match/move/delete from its
      // OLD visual position back to identity (its NEW flow position).
      // Lines whose dx/dy were zero get a no-op transform set; we skip
      // them in the drive loop for perf.
      for (const p of anim.positions) {
        if (p.dx === 0 && p.dy === 0) continue;
        const tx = p.dx * (1 - e);
        const ty = p.dy * (1 - e);
        p.el.style.transform = `translate(${tx}px, ${ty}px)`;
      }

      // Reading offsetWidth/Height forces one reflow per frame — the
      // spans/lines are changing anyway, so no incremental cost. Push
      // the new size into the signals so outer layout (centring) tracks.
      const nw = code.wrapper.offsetWidth;
      const nh = code.wrapper.offsetHeight;
      if (nw !== code.width.peek()) code.width.value = nw;
      if (nh !== code.height.peek()) code.height.value = nh;

      if (u >= 1) return false;
    });
  } finally {
    // Commit the natural new state (plain text lines + fresh highlights).
    code._setSourceAndRender(target);
  }
}
