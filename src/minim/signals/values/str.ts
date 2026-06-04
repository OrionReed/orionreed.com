// str.ts — reactive string with a symmetric lens chain.
//
// String projections are the canonical use case for the engine's
// stateful-lens primitive (`statefulLens` in signal.ts). Every
// useful view — trim, lowercase, words, sorted-unique — loses
// information that the engine recovers on write via the per-cell
// `complement`. Editing through ANY view propagates back to the source
// with the lost detail preserved: case patterns, whitespace runs,
// separators, duplicate positions. The Foster/Pierce "case-preserving
// find-and-replace" headline demo, plus everything that falls out of
// the same complement machinery.
//
// Two invertibles ride the plain endo `.lens(fwd, bwd)`:
//   `reverse()` and `rot13()` are involutions (their own inverses) —
//   no complement needed. They participate in chain fusion like
//   any other endo lens (and also fuse on top of symmetric receivers
//   via the engine's `_fuseOnSymmetric` path).
//
// Everything else is built via `Str.lens(parent, spec)` with a
// non-trivial complement:
//
//   trim         — complement: leading + trailing whitespace
//   lowercase    — complement: per-character case mask of the source
//   uppercase    — dual of lowercase
//   words        — complement: full separator pattern between words
//   sortedUnique — complement: source positions + original case per
//                  unique word; writing one entry broadcasts to every
//                  occurrence in the source with its original casing.

import { type Init, Signal, type Writable } from "../signal";
import type { TraitDict } from "../traits";

type V = string;

// ── complement-carrying endo lens ──────────────────────────────────
//
// The string projections (trim, case, words, sortedUnique) carry a
// complement: state recorded forward from the source and consumed on
// write-back. The complement persists across the lens's OWN writes (so
// `trim` remembers its padding even after the user collapses the view to
// empty) and refreshes on EXTERNAL source changes.
//
// Built on `statefulLens`: `step` re-records the complement on external
// source changes and keeps it on the lens's own back-write (the engine
// supplies the `external` flag — no manual self-write marker).

/** Endo lens backed by a complement recorded from the source. `record`
 *  rebuilds the complement (kept on the lens's own writes), `project`
 *  is the forward view, `reconstruct` is the backward source. */
function complementLens<C>(
  parent: Str,
  record: (s: V) => C,
  project: (s: V) => V,
  reconstruct: (target: V, complement: C) => V,
): Writable<Str> {
  return Str.statefulLens([parent], {
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

const ASCII_LETTER = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

/** Apply the case PATTERN of a source word to a target word. Detects
 *  the three common conventions before falling back to position-wise:
 *
 *    all-upper  → all target letters uppercased ("BROWN" + "purple" → "PURPLE")
 *    all-lower  → all target letters lowercased ("fox"   + "WOLF"   → "wolf")
 *    title case → first letter up, rest down    ("The"   + "wolf"   → "Wolf")
 *    other      → position-wise applyCaseMask   (mixed, partial-cap, etc.)
 *
 *  In every case, NON-LETTER characters in the target pass through
 *  unchanged — title case applied to "-gng" produces "-Gng" (first
 *  letter uppercased, leading dash unchanged), not "-gng" with a
 *  no-op uppercased dash. Without the letter-aware handling, GetPut
 *  fails on any source word containing non-letter characters because
 *  position 0 of the target may not even be a letter. */
export function applyCasePattern(target: V, mask: string): V {
  if (target.length === 0 || mask.length === 0) return target;
  const letters = [...mask].filter(c => c === "U" || c === "L");
  if (letters.length === 0) return target;
  if (letters.every(c => c === "U")) return target.toUpperCase();
  if (letters.every(c => c === "L")) return target.toLowerCase();
  if (letters[0] === "U" && letters.slice(1).every(c => c === "L")) {
    // Title case: uppercase the FIRST letter (skipping leading
    // non-letters), lowercase every subsequent letter, pass non-
    // letters through unchanged.
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

/** A "word" character: letters (any script), digits, underscore,
 *  apostrophe, hyphen — enough to handle typical English plus common
 *  contractions ("don't") and hyphenated terms ("co-op"). Everything
 *  else (whitespace, punctuation, brackets) becomes a separator. */
const WORD_CHAR = /[\p{L}\p{N}_'-]/u;

/** Strip every non-word character. Used by the `words` and
 *  `sortedUnique` views' putl to enforce that user-typed punctuation
 *  in those views (which project word tokens only) does NOT leak into
 *  the source via the separator complement. Without this, the view's
 *  contract ("each line is one word") and the complement's contract
 *  ("separators capture everything else") would fight: extra `!` in a
 *  line would land inside the source's adjacent separator, persist
 *  there across reads, and re-emerge multiplied on the next edit. */
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

/** Inverse of `parseWords`. Interleaves words with separators using
 *  the layout in `seps`. When the new word list is longer than the
 *  original (user added words), interior gaps fall back to `" "`. When
 *  shorter, the original trailing separator is restored at the end so
 *  removing words doesn't drop punctuation.
 *
 *  When the original had zero words (`seps.length === 1`), the single
 *  entry is treated as LEAD only — no trail — so writing words into a
 *  whitespace-only source appends them after the lead without double-
 *  counting it as trail. */
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
      // Interior separators only — the final entry in `seps` is the
      // trail, kept for after the last word.
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

/** Build the case complement from a source string. Both the
 *  positional `wordMasks` array AND the content-keyed `byContent` map
 *  are populated in one parse pass. The byContent value lists are
 *  stored in source order so FIFO consumption in `putl` matches up
 *  duplicate words to their source positions. */
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
  // Per-call clone so we can consume FIFO without mutating the stored
  // map — multiple `putl` calls with the same complement must each
  // start from the same byContent state.
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
  /** Per-word case mask, indexed by word position from `parseWords`.
   *  Used as a fallback for new content the user types — a word added
   *  at position `i` inherits the source's positional mask at `i`
   *  (e.g., renaming "Fox" → "Wolf" gives "Wolf" because position 3
   *  was title case). */
  wordMasks: string[];
  /** Case masks keyed by lowercased source word. The primary lookup —
   *  when the user splits / inserts / reorders without renaming, each
   *  surviving word recovers its source mask by content rather than
   *  by position. Multiple occurrences keep their masks in source
   *  order (FIFO-consumed in `putl`), so "Hello hello" round-trips
   *  exactly even across structural edits. Per-position fallback
   *  handles purely new content. */
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

export class Str extends Signal<V> {
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

  /** Trim leading and trailing whitespace. The complement remembers
   *  exactly what was trimmed; writes restore the original padding.
   *
   *  Edge whitespace in the user's WRITE is stripped before splicing —
   *  the view's contract is "no edge whitespace", so accepting it on
   *  writes would silently append to the padding complement and grow
   *  unboundedly across edits. Same rule as `words` / `sortedUnique`. */
  trim(): Writable<Str> {
    return complementLens<TrimComplement>(
      this,
      s => {
        const lead = /^\s*/.exec(s)?.[0] ?? "";
        // Guard against all-whitespace strings where lead consumes the
        // entire input — trail would otherwise overlap with lead.
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
      // Edge whitespace in the WRITE is dropped — the view's contract is
      // "no edge whitespace"; the complement restores the original pad.
      (target, c) => c.lead + target.replace(/^\s+/, "").replace(/\s+$/, "") + c.trail,
    );
  }

  /** Lowercase view. Word-aware case recovery: on write, each target
   *  word recovers its case from the current source.
   *
   *  Lookup priority (in `applyCaseFromSource`):
   *    1. Content match — if the lowercased target word appears in the
   *       source, consume its first remaining source mask (FIFO). Keeps
   *       "Jumps" capitalised when an unrelated split shifts indices,
   *       and preserves per-word case across reorderings.
   *    2. Per-position fallback — the source mask at position `i` covers
   *       new content (renames "Fox" → "Wolf" → "Wolf" because position
   *       3 was title case).
   *    3. Native — completely new content beyond the source structure
   *       stays as the user typed it.
   *
   *  Round-trips ride on the source: each write recomputes the masks
   *  from the current source, so split/rejoin restores the original. */
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

  /** Words view, one word per line.
   *
   *  Read: split on non-word characters, join with `\n`.
   *  Complement: the separator layout (lead, between-each, trail).
   *  Write: split the new line-separated target into words, rebuild
   *  the source with the original separators. Adding words inserts
   *  single spaces; removing words preserves the trailing separator.
   *
   *  Non-word characters typed into a line are STRIPPED before write —
   *  the view's contract is "each line is one word token". Without the
   *  strip, user-typed punctuation would land inside the source's
   *  adjacent separator and accumulate across edits. To add punctuation
   *  to the source, edit `Trimmed` / `Lowercased` / `Source` instead. */
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

  /** Sorted unique words, one per line. Case-insensitive uniqueness;
   *  alphabetical sort.
   *
   *  Read: parse source into words, canonicalize to lowercase, dedupe,
   *  sort, join with `\n`.
   *
   *  Complement: for each unique entry, the list of source positions
   *  where it appeared AND the original cased form at each one. So
   *  editing a single line broadcasts to every occurrence in the
   *  source — each rebuilt with that occurrence's original case mask.
   *
   *  This is the "edit a deduped view and watch all matching words in
   *  the source update with their original capitalisation preserved"
   *  demo — the moment where the symmetric machinery looks like magic. */
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
        return { unique, positions: unique.map(k => buckets.get(k)!), separators: seps, sourceWords: words };
      },
      s => {
        const { words } = parseWords(s);
        return [...new Set(words.map(w => w.toLowerCase()))].sort().join("\n");
      },
      (target, c) => {
        // Non-word characters typed into the view are stripped — same
        // rule as `words` (sortedUnique's read also drops separators).
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
 *  reactive RO tracking, or `signal.value` to snapshot. */
export function str(v: Init<Str> = ""): Writable<Str> {
  if (v instanceof Str) return v as Writable<Str>;
  return new Str(v) as Writable<Str>;
}
