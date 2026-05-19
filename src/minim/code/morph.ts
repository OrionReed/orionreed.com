// Line-aware morph for CodeShape.
//
// Three-op model. After LCS over old/new lines (fuzzy on trimmed text)
// every line lands as one of:
//
//   Kept   — present in both. Holds (oldIdx, newIdx). One line element,
//            plain text if old === new; otherwise its children are a
//            token-level diff of inline-block `del`/`ins`/`match` spans
//            and width-animate within the line. Either way a position
//            transform interpolates from the line's old visual position
//            to its new flow position.
//   Lost   — only in old. The line element collapses (width + height +
//            opacity → 0) and is removed at commit.
//   Gained — only in new. The line element opens up (width + height +
//            opacity from 0 → natural) at its new flow position.
//
// One classifier pass produces Kept/Lost/Gained from the raw LCS walk:
// LCS matches become Kept; an insert pairs with the immediately-previous
// unpaired delete (same-position inline modify → Kept) OR with any
// unpaired delete sharing its trimmed text (cross-position move → Kept);
// anything unpaired is Lost or Gained.
//
// Layout note. Each Kept-with-diff line's children use `inline-block`
// with `overflow: visible` + `clip-path: inset(0)` — the spec rule that
// bumps an `inline-block`'s baseline to its bottom margin edge when it
// contains multi-line content (or `overflow: hidden`) would deform the
// surrounding flow. `clip-path` clips visually without touching baseline.

import {drive, easeInOut, type Animator, type Easing} from "@minim/core";
import {LINE_CLASS, makeLineEl, type CodeShape} from "./code";
import {tokenize, type Token} from "./tokenize";

// ── Token-level diff (within a Kept-with-content-change line) ───────

type TokenOp =
  | {kind: "match"; text: string}
  | {kind: "del"; text: string}
  | {kind: "ins"; text: string};

function diffTokens(oldToks: readonly Token[], newToks: readonly Token[]): TokenOp[] {
  const m = oldToks.length;
  const n = newToks.length;
  const eq = (a: Token, b: Token): boolean => a.type === b.type && a.text === b.text;

  const dp: number[][] = Array.from({length: m + 1}, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = eq(oldToks[i], newToks[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: TokenOp[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (eq(oldToks[i], newToks[j])) {
      out.push({kind: "match", text: oldToks[i].text});
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({kind: "del", text: oldToks[i].text});
      i++;
    } else {
      out.push({kind: "ins", text: newToks[j].text});
      j++;
    }
  }
  while (i < m) out.push({kind: "del", text: oldToks[i++].text});
  while (j < n) out.push({kind: "ins", text: newToks[j++].text});
  return out;
}

// ── Line-level LCS + classification ─────────────────────────────────

interface RawMatch {kind: "match"; oldIdx: number; newIdx: number}
interface RawDel {kind: "del"; oldIdx: number}
interface RawIns {kind: "ins"; newIdx: number}
type RawOp = RawMatch | RawDel | RawIns;

/** LCS over `trimStart`-equal lines. Indent-only changes still match,
 *  so the line follows its content and the indent shift becomes an
 *  inline edit rather than a fade-out + fade-in. */
function lcsLines(oldLines: readonly string[], newLines: readonly string[]): RawOp[] {
  const eq = (a: string, b: string): boolean => a.trimStart() === b.trimStart();
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({length: m + 1}, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = eq(oldLines[i], newLines[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: RawOp[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (eq(oldLines[i], newLines[j])) {
      ops.push({kind: "match", oldIdx: i, newIdx: j});
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({kind: "del", oldIdx: i});
      i++;
    } else {
      ops.push({kind: "ins", newIdx: j});
      j++;
    }
  }
  while (i < m) ops.push({kind: "del", oldIdx: i++});
  while (j < n) ops.push({kind: "ins", newIdx: j++});
  return ops;
}

interface Kept {kind: "kept"; oldIdx: number; newIdx: number}
interface Lost {kind: "lost"; oldIdx: number}
interface Gained {kind: "gained"; newIdx: number}
type LineOp = Kept | Lost | Gained;

/** Classify raw LCS ops into Kept/Lost/Gained. One pass.
 *
 *   - LCS match → Kept.
 *   - Insert with an unpaired delete immediately before it → Kept
 *     (same-position inline edit).
 *   - Insert with any unpaired delete of equal trimmed text → Kept
 *     (cross-position move).
 *   - Anything else → Gained for inserts, Lost for deletes.
 *
 *  Output order preserves the raw LCS walk so resulting DOM order
 *  roughly matches new-source flow with deletes interleaved near their
 *  old neighbours (which is what the position transforms expect). */
function classify(
  raw: readonly RawOp[],
  oldLines: readonly string[],
  newLines: readonly string[],
): LineOp[] {
  const delByText = new Map<string, number[]>();
  for (let k = 0; k < raw.length; k++) {
    const op = raw[k];
    if (op.kind !== "del") continue;
    const t = oldLines[op.oldIdx].trimStart();
    if (t === "") continue;
    const bucket = delByText.get(t);
    if (bucket) bucket.push(k);
    else delByText.set(t, [k]);
  }

  const paired = new Set<number>();
  const insertPair = new Map<number, number>();
  for (let k = 0; k < raw.length; k++) {
    const op = raw[k];
    if (op.kind !== "ins") continue;
    if (k > 0 && raw[k - 1].kind === "del" && !paired.has(k - 1)) {
      paired.add(k - 1);
      insertPair.set(k, k - 1);
      continue;
    }
    const t = newLines[op.newIdx].trimStart();
    if (t === "") continue;
    const bucket = delByText.get(t);
    if (!bucket) continue;
    while (bucket.length > 0 && paired.has(bucket[0])) bucket.shift();
    if (bucket.length === 0) continue;
    const delIdx = bucket.shift()!;
    paired.add(delIdx);
    insertPair.set(k, delIdx);
  }

  const out: LineOp[] = [];
  for (let k = 0; k < raw.length; k++) {
    const op = raw[k];
    if (op.kind === "match") {
      out.push({kind: "kept", oldIdx: op.oldIdx, newIdx: op.newIdx});
    } else if (op.kind === "del") {
      if (paired.has(k)) continue;
      out.push({kind: "lost", oldIdx: op.oldIdx});
    } else {
      const delIdx = insertPair.get(k);
      if (delIdx !== undefined) {
        const delOp = raw[delIdx] as RawDel;
        out.push({kind: "kept", oldIdx: delOp.oldIdx, newIdx: op.newIdx});
      } else {
        out.push({kind: "gained", newIdx: op.newIdx});
      }
    }
  }
  return out;
}

// ── Span classes ────────────────────────────────────────────────────
//
// These class names are the ONLY source of truth distinguishing morph
// children. The painter in `code.ts` derives old-text-view / new-text-
// view by filtering on these names — no out-of-band metadata.

const CLASS_DEL = "minim-code-del";
const CLASS_INS = "minim-code-ins";
const CLASS_MATCH = "minim-code-match";

// ── Building the morph DOM ──────────────────────────────────────────

interface InlineAnim {el: HTMLSpanElement; naturalWidth: number}
interface LineAnim {el: HTMLSpanElement; naturalHeight: number; naturalWidth: number}
interface PositionAnim {el: HTMLSpanElement; dx: number; dy: number}

type LineEntry =
  | {kind: "kept"; el: HTMLSpanElement; newIdx: number}
  | {kind: "lost"; el: HTMLSpanElement}
  | {kind: "gained"; el: HTMLSpanElement; newIdx: number};

interface Built {
  entries: LineEntry[];
  lineDeletes: LineAnim[];
  lineInserts: LineAnim[];
  inlineDeletes: InlineAnim[];
  inlineInserts: InlineAnim[];
  positionTargets: Array<{el: HTMLSpanElement; oldIdx: number}>;
}

function makeInlineSpan(text: string, className: string): HTMLSpanElement {
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

/** Replace `lineEl`'s content with coalesced match/del/ins spans
 *  matching the token-level diff. Match spans are plain wrappers (the
 *  painter recognises them by class). */
function buildInlineMorph(lineEl: HTMLElement, ops: readonly TokenOp[]): {
  deletes: HTMLSpanElement[];
  inserts: HTMLSpanElement[];
} {
  while (lineEl.firstChild) lineEl.removeChild(lineEl.firstChild);
  const deletes: HTMLSpanElement[] = [];
  const inserts: HTMLSpanElement[] = [];

  let i = 0;
  while (i < ops.length) {
    const kind = ops[i].kind;
    let text = "";
    while (i < ops.length && ops[i].kind === kind) {
      text += ops[i].text;
      i++;
    }
    if (kind === "match") {
      const span = document.createElement("span");
      span.className = CLASS_MATCH;
      span.textContent = text;
      lineEl.appendChild(span);
    } else {
      const className = kind === "del" ? CLASS_DEL : CLASS_INS;
      const span = makeInlineSpan(text, className);
      lineEl.appendChild(span);
      (kind === "del" ? deletes : inserts).push(span);
    }
  }
  return {deletes, inserts};
}

function buildLineMorph(
  wrapper: HTMLElement,
  ops: readonly LineOp[],
  oldLines: readonly string[],
  newLines: readonly string[],
  language: string,
): Built {
  while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);

  const built: Built = {
    entries: [],
    lineDeletes: [],
    lineInserts: [],
    inlineDeletes: [],
    inlineInserts: [],
    positionTargets: [],
  };

  for (const op of ops) {
    if (op.kind === "kept") {
      const oldText = oldLines[op.oldIdx];
      const newText = newLines[op.newIdx];
      if (oldText === newText) {
        const el = makeLineEl(newText);
        wrapper.appendChild(el);
        built.entries.push({kind: "kept", el, newIdx: op.newIdx});
        built.positionTargets.push({el, oldIdx: op.oldIdx});
      } else {
        // Start at OLD text so t=0 visually matches the old line; the
        // inline morph then animates the content shift to NEW.
        const el = makeLineEl(oldText);
        wrapper.appendChild(el);
        const tops = diffTokens(
          tokenize(oldText, language),
          tokenize(newText, language),
        );
        const {deletes, inserts} = buildInlineMorph(el, tops);
        for (const d of deletes) built.inlineDeletes.push({el: d, naturalWidth: 0});
        for (const i of inserts) built.inlineInserts.push({el: i, naturalWidth: 0});
        built.entries.push({kind: "kept", el, newIdx: op.newIdx});
        built.positionTargets.push({el, oldIdx: op.oldIdx});
      }
    } else if (op.kind === "lost") {
      const el = makeLineEl(oldLines[op.oldIdx]);
      el.style.overflow = "hidden";
      wrapper.appendChild(el);
      built.entries.push({kind: "lost", el});
      built.lineDeletes.push({el, naturalHeight: 0, naturalWidth: 0});
      built.positionTargets.push({el, oldIdx: op.oldIdx});
    } else {
      const el = makeLineEl(newLines[op.newIdx]);
      el.style.overflow = "hidden";
      wrapper.appendChild(el);
      built.entries.push({kind: "gained", el, newIdx: op.newIdx});
      built.lineInserts.push({el, naturalHeight: 0, naturalWidth: 0});
    }
  }

  // Measure naturals AFTER mount and BEFORE overriding min-height,
  // otherwise empty inserted lines report 0 height (and never open up).
  for (const a of built.lineDeletes) {
    a.naturalHeight = a.el.offsetHeight;
    a.naturalWidth = a.el.offsetWidth;
  }
  for (const a of built.lineInserts) {
    a.naturalHeight = a.el.offsetHeight;
    a.naturalWidth = a.el.offsetWidth;
  }
  for (const a of built.inlineDeletes) a.naturalWidth = a.el.offsetWidth;
  for (const a of built.inlineInserts) a.naturalWidth = a.el.offsetWidth;
  for (const a of built.lineDeletes) a.el.style.minHeight = "0";
  for (const a of built.lineInserts) a.el.style.minHeight = "0";

  return built;
}

// ── Public entry ────────────────────────────────────────────────────

/** Animate `code` from its current source to `target`. Cancel-safe —
 *  `finally` replaces every morph line with a fresh plain-text line
 *  element (or removes it, for Lost), then calls `_finalize` which
 *  commits the new source value with the auto-render effect suppressed
 *  and repaints highlights against the now-stable DOM. */
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

  // Capture OLD positions BEFORE wipe — anchor for position transforms.
  const oldLineEls = Array.from(
    code.wrapper.querySelectorAll<HTMLElement>(`.${LINE_CLASS}`),
  );
  const oldPositions = oldLineEls.map((el) => ({x: el.offsetLeft, y: el.offsetTop}));

  const ops = classify(lcsLines(oldLines, newLines), oldLines, newLines);
  const built = buildLineMorph(code.wrapper, ops, oldLines, newLines, code.language);

  // Highlights against the morph DOM: the painter reads class names on
  // the children and reconstructs old/new text views per line.
  code._repaint();

  // t=0 visual state: inserts at zero size, deletes at natural.
  for (const a of built.lineInserts) {
    a.el.style.height = "0px";
    a.el.style.width = "0px";
    a.el.style.opacity = "0";
  }
  for (const a of built.inlineInserts) {
    a.el.style.width = "0px";
    a.el.style.opacity = "0";
  }
  for (const a of built.lineDeletes) {
    a.el.style.height = a.naturalHeight + "px";
    a.el.style.width = a.naturalWidth + "px";
  }

  // Each position-tracked line's t=0 flow position (inserts collapsed),
  // versus its old visual position, gives the translate to put it back
  // where it visually was. `transform = (1-e)·delta` decays to identity.
  const positions: PositionAnim[] = built.positionTargets.map((p) => {
    const oldPos = oldPositions[p.oldIdx] ?? {x: 0, y: 0};
    const dx = oldPos.x - p.el.offsetLeft;
    const dy = oldPos.y - p.el.offsetTop;
    if (dx !== 0 || dy !== 0) p.el.style.transform = `translate(${dx}px, ${dy}px)`;
    return {el: p.el, dx, dy};
  });

  try {
    yield* drive((_dt, t) => {
      const u = Math.min(1, t / dur);
      const e = ease(u);

      for (const a of built.lineDeletes) {
        a.el.style.height = a.naturalHeight * (1 - e) + "px";
        a.el.style.width = a.naturalWidth * (1 - e) + "px";
        a.el.style.opacity = String(1 - e);
      }
      for (const a of built.lineInserts) {
        a.el.style.height = a.naturalHeight * e + "px";
        a.el.style.width = a.naturalWidth * e + "px";
        a.el.style.opacity = String(e);
      }
      for (const a of built.inlineDeletes) {
        a.el.style.width = a.naturalWidth * (1 - e) + "px";
        a.el.style.opacity = String(1 - e);
      }
      for (const a of built.inlineInserts) {
        a.el.style.width = a.naturalWidth * e + "px";
        a.el.style.opacity = String(e);
      }
      for (const p of positions) {
        if (p.dx === 0 && p.dy === 0) continue;
        p.el.style.transform = `translate(${p.dx * (1 - e)}px, ${p.dy * (1 - e)}px)`;
      }

      const nw = code.wrapper.offsetWidth;
      const nh = code.wrapper.offsetHeight;
      if (nw !== code.width.peek()) code.width.value = nw;
      if (nh !== code.height.peek()) code.height.value = nh;

      if (u >= 1) return false;
    });
  } finally {
    // In-place finalize: replace each surviving line with a fresh plain
    // line element holding its new text; remove Lost lines outright.
    // The DOM ends up indistinguishable from a #render(target) without
    // the wholesale wipe of the wrapper.
    for (const entry of built.entries) {
      if (entry.kind === "lost") entry.el.remove();
      else entry.el.replaceWith(makeLineEl(newLines[entry.newIdx]));
    }
    code._finalize(target);
  }
}
