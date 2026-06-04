// morph — animate a CodeShape from its current source to a target.
//
// Parts are just absolutely-positioned signal-bearing spans, so morph
// reduces to: pair old/new lines (LCS over trimmed text), then tween
// the right signals per pair. No DOM rebuild, no FLIP, no drive loop —
// every animation is a `signal.to(...)` and the morph is `yield [...]`.
//
// Per-line outcomes:
//   Kept(same text)    — old part stays; position.y tweens if it moved.
//   Kept(text changed) — old part fades out at its old row; a fresh
//                        part fades in at the new row (whole-line cross-fade).
//   Lost               — old part fades out, disposed on completion.
//   Gained             — fresh part fades in at its new row.

import { type Animator, type Easing, easeInOut, type Yieldable } from "@minim/core";
import { vec } from "@minim/signals";
import { type CodeShape, Part } from "./code";

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

/** LCS over `trimStart`-equal lines; indent-only changes still match
 *  (the shift rides through as a text diff on the Kept line). */
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

/** Classify raw LCS ops into Kept/Lost/Gained. Pairs cross-position
 *  same-trimmed lines first, then adjacent — prefers "line moved" over
 *  "line modified", keeping lines anchored across moves. */
function classify(
  raw: readonly RawOp[],
  oldLines: readonly string[],
  newLines: readonly string[],
): LineOp[] {
  // Pass 1 — cross-position pairing (del/ins with equal trimStart).
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

/** Animate `c` to `target`. Cancel-safe: `finally` disposes transient
 *  parts and commits via `_finalize` (which re-sorts row/col). */
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

  // Parts indexed by oldIdx; assumed in row/col order (render and
  // `_finalize` both maintain this), one part per old line.
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
        // Content changed — whole-line cross-fade: old part out at its
        // old row, fresh part in at the new row.
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
