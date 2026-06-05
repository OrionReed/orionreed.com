// str.ts — reactive string with a symmetric lens chain.
//
// String projections are the canonical use of the engine's stateful-lens
// primitive (`statefulLens`). Every useful view loses information the
// engine recovers on write via a per-cell `complement`, so editing through
// ANY view round-trips with case, whitespace, separators, and duplicate
// positions preserved (the Foster/Pierce case-preserving find-and-replace
// demo).
//
// `reverse()` and `rot13()` are involutions on the plain endo
// `.lens(fwd, bwd)` — no complement; they chain like any endo lens.
// Everything else is `Str.lens(parent, spec)` with a complement:
//
//   trim         — leading + trailing whitespace
//   lowercase    — per-character case mask of the source
//   uppercase    — dual of lowercase
//   words        — separator pattern between words
//   sortedUnique — source positions + original case per unique word

import { Cell, type Init, type Writable } from "../signal";
import type { TraitDict } from "../traits";

type V = string;

// ── complement-carrying endo lens ──────────────────────────────────
//
// The complement is state recorded forward from the source and consumed
// on write-back. It persists across the lens's own writes (so `trim`
// keeps its padding even when the view is emptied) and refreshes on
// external source changes — the engine's `external` flag drives `step`.

/** Endo lens backed by a complement recorded from the source. `record`
 *  rebuilds the complement (kept on the lens's own writes), `project`
 *  is the forward view, `reconstruct` is the backward source. */
function complementLens<C>(
  parent: Str,
  record: (s: V) => C,
  project: (s: V) => V,
  reconstruct: (target: V, complement: C) => V,
): Writable<Str> {
  return Str.lens([parent], {
    init: ([s]) => record(s),
    step: ([s], c, external) => (external ? record(s) : c),
    fwd: ([s]) => project(s),
    bwd: (target, _s, c) => ({ updates: [reconstruct(target, c)], complement: c }),
  }) as Writable<Str>;
}

export const equals = (a: V, b: V) => a === b;

// ── pure isomorphisms (exported as utilities) ──────────────────────

/** Reverse a string by Unicode code points. */
export const reverseStr = (s: V): V => [...s].reverse().join("");

/** ROT13 cipher. Involutive: `rot13(rot13(s)) === s`. */
export const rot13Str = (s: V): V =>
  s.replace(/[a-zA-Z]/g, c => {
    const code = c.charCodeAt(0);
    const base = code >= 97 ? 97 : 65;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });

// ── case mask utilities ────────────────────────────────────────────

/** Per-character case mask: `U` upper letter, `L` lower letter,
 *  `" "` non-letter. Length matches the source. */
export function caseMaskOf(s: V): string {
  let mask = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c >= "A" && c <= "Z") mask += "U";
    else if (c >= "a" && c <= "z") mask += "L";
    else mask += " ";
  }
  return mask;
}

/** Apply a case mask to `target`, position by position. Mask positions
 *  beyond `target.length` are ignored; target positions beyond the
 *  mask keep their native case (e.g. user appended a longer word). */
export function applyCaseMask(target: V, mask: string): V {
  let out = "";
  for (let i = 0; i < target.length; i++) {
    const c = target[i]!;
    const m = i < mask.length ? mask[i] : " ";
    if (m === "U") out += c.toUpperCase();
    else if (m === "L") out += c.toLowerCase();
    else out += c;
  }
  return out;
}

const ASCII_LETTER = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

/** Apply the case pattern of a source word to a target word. Detects
 *  all-upper / all-lower / title case, else falls back to position-wise
 *  `applyCaseMask`. Non-letter target chars always pass through unchanged
 *  (title-casing "-gng" → "-Gng"); this letter-awareness is what makes
 *  GetPut hold when source words contain non-letters. */
export function applyCasePattern(target: V, mask: string): V {
  if (target.length === 0 || mask.length === 0) return target;
  const letters = [...mask].filter(c => c === "U" || c === "L");
  if (letters.length === 0) return target;
  if (letters.every(c => c === "U")) return target.toUpperCase();
  if (letters.every(c => c === "L")) return target.toLowerCase();
  if (letters[0] === "U" && letters.slice(1).every(c => c === "L")) {
    // Title case: uppercase the first letter (skipping leading
    // non-letters), lowercase the rest, pass non-letters through.
    let out = "";
    let firstLetterDone = false;
    for (let i = 0; i < target.length; i++) {
      const c = target[i]!;
      if (ASCII_LETTER(c)) {
        out += firstLetterDone ? c.toLowerCase() : c.toUpperCase();
        firstLetterDone = true;
      } else {
        out += c;
      }
    }
    return out;
  }
  return applyCaseMask(target, mask);
}

// ── word-split utilities ───────────────────────────────────────────

/** A "word" character: letters, digits, underscore, apostrophe, hyphen
 *  (handles "don't", "co-op"). Everything else is a separator. */
const WORD_CHAR = /[\p{L}\p{N}_'-]/u;

/** Strip every non-word character. Keeps user-typed punctuation in the
 *  `words` / `sortedUnique` views from leaking into the source via the
 *  separator complement (where it would accumulate across edits). */
const stripNonWord = (s: V): V => s.replace(/[^\p{L}\p{N}_'-]/gu, "");

/** Split `s` into words and separators. Returns:
 *
 *    words[i] — the i-th run of word characters
 *    seps[0]  — leading non-word characters (possibly empty)
 *    seps[i]  — for 1 ≤ i ≤ words.length-1, the separator BETWEEN
 *               `words[i-1]` and `words[i]`
 *    seps[words.length] — trailing non-word characters
 *
 *  Always satisfies `seps.length === words.length + 1`. */
export function parseWords(s: V): { words: V[]; seps: V[] } {
  const words: V[] = [];
  const seps: V[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (WORD_CHAR.test(c)) {
      if (!inWord) {
        seps.push(cur);
        cur = "";
        inWord = true;
      }
      cur += c;
    } else {
      if (inWord) {
        words.push(cur);
        cur = "";
        inWord = false;
      }
      cur += c;
    }
  }
  if (inWord) {
    words.push(cur);
    seps.push("");
  } else {
    seps.push(cur);
  }
  return { words, seps };
}

/** Inverse of `parseWords`. Interleaves words with `seps`; added words
 *  get `" "` gaps, removed words keep the original trailing separator.
 *  A zero-word original (`seps.length === 1`) treats its one entry as
 *  lead only, so words append after it without double-counting as trail. */
export function rebuildWords(words: V[], seps: V[]): V {
  const n = words.length;
  if (n === 0) return seps[0] ?? "";
  const lead = seps[0] ?? "";
  const trail = seps.length > 1 ? (seps[seps.length - 1] ?? "") : "";
  let out = lead;
  for (let i = 0; i < n; i++) {
    out += words[i];
    if (i < n - 1) {
      const idx = i + 1;
      // Interior separators only; the final `seps` entry is the trail.
      const sep = idx < seps.length - 1 ? seps[idx] : undefined;
      out += sep !== undefined ? sep : " ";
    } else {
      out += trail;
    }
  }
  return out;
}

// ── complement shapes ──────────────────────────────────────────────

interface TrimComplement {
  lead: string;
  trail: string;
}

/** (Re)build the case complement: positional `wordMasks` and content-keyed
 *  `byContent` in one pass. `byContent` lists stay in source order for FIFO
 *  consumption in `putl`. */
function refreshCaseComplement(s: V, c: CaseComplement): void {
  const { words } = parseWords(s);
  const wordMasks = words.map(caseMaskOf);
  const byContent = new Map<string, string[]>();
  for (let i = 0; i < words.length; i++) {
    const key = words[i]!.toLowerCase();
    let arr = byContent.get(key);
    if (arr === undefined) {
      arr = [];
      byContent.set(key, arr);
    }
    arr.push(wordMasks[i]!);
  }
  c.wordMasks = wordMasks;
  c.byContent = byContent;
}

/** Apply the case complement to a target string and rebuild. Each
 *  target word goes through three lookup tiers — content match
 *  (FIFO-consumed from a per-call clone), positional fallback, then
 *  native pass-through. */
function applyCaseComplement(target: V, c: CaseComplement): V {
  const { words, seps } = parseWords(target);
  // Per-call clone: consume FIFO without mutating the stored map, so
  // repeated `putl` calls start from the same state.
  const remaining = new Map<string, string[]>();
  for (const [k, arr] of c.byContent) remaining.set(k, arr.slice());
  const cased = words.map((w, i) => {
    const key = w.toLowerCase();
    const matches = remaining.get(key);
    if (matches !== undefined && matches.length > 0) {
      return applyCasePattern(w, matches.shift()!);
    }
    const mask = i < c.wordMasks.length ? c.wordMasks[i]! : "";
    return mask.length === 0 ? w : applyCasePattern(w, mask);
  });
  return rebuildWords(cased, seps);
}

/** Build a fresh case complement from a source string. */
function buildCaseComplement(s: V): CaseComplement {
  const c: CaseComplement = { wordMasks: [], byContent: new Map() };
  refreshCaseComplement(s, c);
  return c;
}

interface CaseComplement {
  /** Per-position case mask (positional fallback for new content — a
   *  word added at `i` inherits the source mask at `i`). */
  wordMasks: string[];
  /** Case masks keyed by lowercased word — the primary lookup; survives
   *  split / insert / reorder. Duplicates stay in source order
   *  (FIFO-consumed in `putl`). */
  byContent: Map<string, string[]>;
}

interface WordsComplement {
  separators: string[];
}

interface SortedUniqueComplement {
  /** Output position → [(source word index, original cased word), ...]
   *  for every occurrence of this unique key in the source. */
  positions: Array<Array<{ index: number; sourceCase: string }>>;
  /** Sorted unique canonical keys, parallel to `positions`. */
  unique: string[];
  /** Source separator layout (length = sourceWords.length + 1). */
  separators: string[];
  /** Source words in original order, cased. */
  sourceWords: string[];
}

// ── Str class ─────────────────────────────────────────────────────

export class Str extends Cell<V> {
  static traits = { equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Str.traits;

  constructor(v: V = "") {
    super(v, { equals });
  }

  // ── pure isomorphisms ────────────────────────────────────────────

  /** Reverse. Involution. */
  reverse(): this {
    return this.lens(reverseStr, reverseStr);
  }

  /** ROT13. Involution. */
  rot13(): this {
    return this.lens(rot13Str, rot13Str);
  }

  // ── symmetric projections ────────────────────────────────────────

  /** Trim edge whitespace; the complement restores the original padding
   *  on write. Edge whitespace in a write is stripped first (the view's
   *  contract is "no edge whitespace", else the complement grows). */
  trim(): Writable<Str> {
    return complementLens<TrimComplement>(
      this,
      s => {
        const lead = /^\s*/.exec(s)?.[0] ?? "";
        // Slice lead off first so trail can't overlap it on all-whitespace.
        const remain = s.slice(lead.length);
        const trail = /\s*$/.exec(remain)?.[0] ?? "";
        return { lead, trail };
      },
      s => {
        const lead = /^\s*/.exec(s)?.[0] ?? "";
        const remain = s.slice(lead.length);
        const trail = /\s*$/.exec(remain)?.[0] ?? "";
        return remain.slice(0, remain.length - trail.length);
      },
      // Edge whitespace in the write is dropped; complement restores pad.
      (target, c) => c.lead + target.replace(/^\s+/, "").replace(/\s+$/, "") + c.trail,
    );
  }

  /** Lowercase view with word-aware case recovery on write. Lookup
   *  priority: (1) content match — recover the source mask by word
   *  (FIFO across duplicates); (2) per-position fallback for new content;
   *  (3) native for content beyond the source structure. */
  lowercase(): Writable<Str> {
    return complementLens<CaseComplement>(
      this,
      s => buildCaseComplement(s),
      s => s.toLowerCase(),
      (target, c) => applyCaseComplement(target, c),
    );
  }

  /** Uppercase view. Dual of `lowercase`; same per-word case recovery. */
  uppercase(): Writable<Str> {
    return complementLens<CaseComplement>(
      this,
      s => buildCaseComplement(s),
      s => s.toUpperCase(),
      (target, c) => applyCaseComplement(target, c),
    );
  }

  /** Words view, one word per line. Read splits on non-word chars; the
   *  complement is the separator layout, restored on write (added words
   *  get single spaces). Non-word chars typed into a line are stripped —
   *  edit `Trimmed` / `Lowercased` / `Source` to add punctuation. */
  words(): Writable<Str> {
    return complementLens<WordsComplement>(
      this,
      s => ({ separators: parseWords(s).seps }),
      s => parseWords(s).words.join("\n"),
      (target, c) => {
        const words = target
          .split(/\n/)
          .map(stripNonWord)
          .filter(w => w.length > 0);
        return rebuildWords(words, c.separators);
      },
    );
  }

  /** Sorted, case-insensitively-unique words, one per line. The
   *  complement records each entry's source positions and original case,
   *  so editing one line broadcasts to every occurrence in the source —
   *  each rebuilt with its own original casing. */
  sortedUnique(): Writable<Str> {
    return complementLens<SortedUniqueComplement>(
      this,
      s => {
        const { words, seps } = parseWords(s);
        const buckets = new Map<string, Array<{ index: number; sourceCase: string }>>();
        for (let i = 0; i < words.length; i++) {
          const w = words[i]!;
          const key = w.toLowerCase();
          let arr = buckets.get(key);
          if (arr === undefined) {
            arr = [];
            buckets.set(key, arr);
          }
          arr.push({ index: i, sourceCase: w });
        }
        const unique = [...buckets.keys()].sort();
        return {
          unique,
          positions: unique.map(k => buckets.get(k)!),
          separators: seps,
          sourceWords: words,
        };
      },
      s => {
        const { words } = parseWords(s);
        return [...new Set(words.map(w => w.toLowerCase()))].sort().join("\n");
      },
      (target, c) => {
        // Strip non-word chars typed into the view, same as `words`.
        const edited = target
          .split(/\n/)
          .map(stripNonWord)
          .filter(w => w.length > 0);
        const sourceWords = c.sourceWords.slice();
        const n = Math.min(edited.length, c.unique.length);
        for (let i = 0; i < n; i++) {
          const newWord = edited[i]!;
          for (const { index, sourceCase } of c.positions[i]!) {
            if (index >= sourceWords.length) continue;
            sourceWords[index] = applyCasePattern(newWord, caseMaskOf(sourceCase));
          }
        }
        return rebuildWords(sourceWords, c.separators);
      },
    );
  }
}

/** Writable `Str`. Strict factory: literal seeds a fresh cell;
 *  existing `Writable<Str>` passes through by identity. RO sources
 *  are rejected at the type level — use `Str.derive(...)` for
 *  reactive RO tracking, or `cell.value` to snapshot. */
export function str(v: Init<Str> = ""): Writable<Str> {
  if (v instanceof Str) return v as Writable<Str>;
  return new Str(v) as Writable<Str>;
}
