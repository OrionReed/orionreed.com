// morph — animate a CodeShape from its current source to a target.
//
// The substrate is glyph-free, line-element-free, and clip-path-free —
// it's just a flat list of absolutely-positioned `Part`s with signal
// properties. So morph reduces to: pair old and new lines (LCS over
// trimmed text), then for each pair / leftover, choose which signals
// to tween. There is no DOM rebuild, no FLIP capture-then-decay, no
// drive loop — every animation is a chainable `signal.to(...)` and the
// whole morph is `yield [...all of them]`.
//
// Per-line outcomes:
//   Kept(same text)    — the old part stays; position.y tweens if the
//                        line moved to a different row.
//   Kept(text changed) — old part fades to opacity 0 (at its old row);
//                        a fresh part is created at the new row with
//                        opacity 0 and fades to 1. Whole-line cross-
//                        fade. Sub-line token-level diff can layer on
//                        top later via cut/uncut without changing the
//                        substrate.
//   Lost               — old part fades to 0 at its old row, disposed
//                        on completion.
//   Gained             — fresh part created at its new row with
//                        opacity 0, fades to 1.

import { type Animator, type Easing, easeInOut, type Yieldable } from "@minim/core";
import { vec } from "@minim/signals";
import { type CodeShape, Part } from "./code";

// ── Line-level LCS + classification ─────────────────────────────────

interface RawMatch {
  kind: "match";
  oldIdx: number;
  newIdx: number;
}
interface RawDel {
  kind: "del";
  oldIdx: number;
}
interface RawIns {
  kind: "ins";
  newIdx: number;
}
type RawOp = RawMatch | RawDel | RawIns;

/** LCS over `trimStart`-equal lines. An indent-only change still
 *  matches; the indent shift rides through as a text difference on the
 *  Kept line. */
function lcsLines(oldLines: readonly string[], newLines: readonly string[]): RawOp[] {
  const eq = (a: string, b: string): boolean => a.trimStart() === b.trimStart();
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = eq(oldLines[i], newLines[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: RawOp[] = [];
  let i = 0,
    j = 0;
  while (i < m && j < n) {
    if (eq(oldLines[i], newLines[j])) {
      ops.push({ kind: "match", oldIdx: i, newIdx: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", oldIdx: i });
      i++;
    } else {
      ops.push({ kind: "ins", newIdx: j });
      j++;
    }
  }
  while (i < m) ops.push({ kind: "del", oldIdx: i++ });
  while (j < n) ops.push({ kind: "ins", newIdx: j++ });
  return ops;
}

interface Kept {
  kind: "kept";
  oldIdx: number;
  newIdx: number;
}
interface Lost {
  kind: "lost";
  oldIdx: number;
}
interface Gained {
  kind: "gained";
  newIdx: number;
}
type LineOp = Kept | Lost | Gained;

/** Classify raw LCS ops into Kept/Lost/Gained in one pass.
 *
 *  Pair priority — cross-position SAME-trimmed first, then adjacent.
 *  This is the inverse of the previous package's order: it ensures we
 *  prefer "this line moved" over "this line was modified to that
 *  line's content", which keeps lines visually anchored across moves. */
function classify(
  raw: readonly RawOp[],
  oldLines: readonly string[],
  newLines: readonly string[],
): LineOp[] {
  // Pass 1 — cross-position pairing (`del X`, `ins Y` where X.trimStart === Y.trimStart).
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

  // Pass 2 — adjacent (del immediately followed by ins) for the rest.
  for (let k = 0; k < raw.length; k++) {
    const op = raw[k];
    if (op.kind !== "ins") continue;
    if (insertPair.has(k)) continue;
    if (k > 0 && raw[k - 1].kind === "del" && !paired.has(k - 1)) {
      paired.add(k - 1);
      insertPair.set(k, k - 1);
    }
  }

  // Emit.
  const out: LineOp[] = [];
  for (let k = 0; k < raw.length; k++) {
    const op = raw[k];
    if (op.kind === "match") {
      out.push({ kind: "kept", oldIdx: op.oldIdx, newIdx: op.newIdx });
    } else if (op.kind === "del") {
      if (paired.has(k)) continue;
      out.push({ kind: "lost", oldIdx: op.oldIdx });
    } else {
      const delIdx = insertPair.get(k);
      if (delIdx !== undefined) {
        const delOp = raw[delIdx] as RawDel;
        out.push({ kind: "kept", oldIdx: delOp.oldIdx, newIdx: op.newIdx });
      } else {
        out.push({ kind: "gained", newIdx: op.newIdx });
      }
    }
  }
  return out;
}

// ── Public entry ────────────────────────────────────────────────────

/** Animate `c` from its current source to `target`. Cancel-safe — the
 *  `finally` clause disposes any transient parts and commits via
 *  `_finalize`, which also re-sorts the parts list into row/col order
 *  for indexable lookup. */
export function* morph(
  c: CodeShape,
  target: string,
  dur: number,
  ease: Easing = easeInOut,
): Animator<void> {
  const oldSrc = c.source.peek();
  if (oldSrc === target) return;

  const oldLines = oldSrc.split("\n");
  const newLines = target.split("\n");
  const ops = classify(lcsLines(oldLines, newLines), oldLines, newLines);

  // Snapshot the parts list indexed by oldIdx. We assume parts are
  // currently in row/col order (the previous render and the previous
  // morph's `_finalize` both maintain this). One part per old line.
  const oldParts = c.parts.slice();

  const tweens: Yieldable[] = [];
  const transient: Part[] = []; // parts to remove on completion

  for (const op of ops) {
    if (op.kind === "kept") {
      const oldPart = oldParts[op.oldIdx];
      const newText = newLines[op.newIdx];
      const newY = op.newIdx * c.lineH;

      if (oldPart.text === newText) {
        // Same content — only animate if the row changed.
        if (oldPart.position.peek().y !== newY) {
          tweens.push(oldPart.position.to(vec(0, newY).value, dur, ease));
        }
      } else {
        // Content changed — cross-fade the whole line in place at the
        // new row. Old part fades out (at its old row); fresh part
        // fades in (at the new row). Sub-line diff can layer on later
        // by cut/uncut between these two endpoints.
        const fresh = new Part(newText, 0, newY);
        fresh.opacity.value = 0;
        c.wrapper.appendChild(fresh.el);
        c.parts.push(fresh);
        tweens.push(oldPart.opacity.to(0, dur, ease));
        tweens.push(fresh.opacity.to(1, dur, ease));
        transient.push(oldPart);
      }
    } else if (op.kind === "lost") {
      const oldPart = oldParts[op.oldIdx];
      tweens.push(oldPart.opacity.to(0, dur, ease));
      transient.push(oldPart);
    } else {
      const newText = newLines[op.newIdx];
      const newY = op.newIdx * c.lineH;
      const fresh = new Part(newText, 0, newY);
      fresh.opacity.value = 0;
      c.wrapper.appendChild(fresh.el);
      c.parts.push(fresh);
      tweens.push(fresh.opacity.to(1, dur, ease));
    }
  }

  try {
    yield tweens;
  } finally {
    for (const p of transient) {
      const i = c.parts.indexOf(p);
      if (i >= 0) c.parts.splice(i, 1);
      p.dispose();
    }
    c._finalize(target);
  }
}
