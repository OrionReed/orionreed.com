// str.ts — reactive string with a symmetric lens chain.
//
// String projections are the canonical use case for the engine's
// symmetric-lens primitive (`SymmetricLensSpec1` in signal.ts). Every
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
import { type TraitDict } from "../traits";

type V = string;

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

/** Apply the case PATTERN of a source word to a target word. Detects
 *  the three common conventions before falling back to position-wise:
 *
 *    all-upper  → target.toUpperCase()        ("BROWN" + "purple" → "PURPLE")
 *    all-lower  → target.toLowerCase()        ("fox"   + "WOLF"   → "wolf")
 *    title case → first cap, rest lower       ("The"   + "wolf"   → "Wolf")
 *    other      → position-wise applyCaseMask (mixed, partial-cap, etc.)
 *
 *  This is what makes case-preserving writes survive word-length
 *  changes — under pure position-wise application, "fox" → "wolf" in a
 *  source where "fox" is at the boundary would shift everything after
 *  by one position and corrupt the mask alignment. The pattern check
 *  fixes the common cases that humans actually care about. */
export function applyCasePattern(target: V, mask: string): V {
  if (target.length === 0 || mask.length === 0) return target;
  const letters = [...mask].filter(c => c === "U" || c === "L");
  if (letters.length > 0 && letters.every(c => c === "U")) return target.toUpperCase();
  if (letters.length > 0 && letters.every(c => c === "L")) return target.toLowerCase();
  // Title case: first letter U, all subsequent letters L (non-letter
  // positions don't count against the pattern).
  if (
    letters.length > 0 &&
    letters[0] === "U" &&
    letters.slice(1).every(c => c === "L")
  ) {
    return target.charAt(0).toUpperCase() + target.slice(1).toLowerCase();
  }
  return applyCaseMask(target, mask);
}

// ── word-split utilities ───────────────────────────────────────────

/** A "word" character: letters (any script), digits, underscore,
 *  apostrophe, hyphen — enough to handle typical English plus common
 *  contractions ("don't") and hyphenated terms ("co-op"). Everything
 *  else (whitespace, punctuation, brackets) becomes a separator. */
const WORD_CHAR = /[\p{L}\p{N}_'-]/u;

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

interface CaseComplement {
  /** Per-word case mask, indexed by word position from `parseWords`. */
  wordMasks: string[];
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
   *  exactly what was trimmed; writes restore the original padding. */
  trim(): Writable<Str> {
    return Str.lens(this, {
      missing: { lead: "", trail: "" } as TrimComplement,
      putr: (s: V, c: TrimComplement) => {
        const lead = /^\s*/.exec(s)?.[0] ?? "";
        // Guard against all-whitespace strings where lead consumes the
        // entire input — trail would otherwise overlap with lead.
        const remain = s.slice(lead.length);
        const trail = /\s*$/.exec(remain)?.[0] ?? "";
        c.lead = lead;
        c.trail = trail;
        return remain.slice(0, remain.length - trail.length);
      },
      putl: (target: V, _s: V, c: TrimComplement) => c.lead + target + c.trail,
    });
  }

  /** Lowercase view. The complement is the per-word case mask of the
   *  source — when you write a new value, each output word picks up
   *  the case pattern (all-caps / Title / lower / mixed) of the source
   *  word at the same word index. Word-aware mask survives word-length
   *  changes; the position-wise fallback handles mixed patterns. The
   *  classical Foster/Pierce case-preserving find-and-replace example. */
  lowercase(): Writable<Str> {
    return Str.lens(this, {
      missing: { wordMasks: [] } as CaseComplement,
      putr: (s: V, c: CaseComplement) => {
        const { words } = parseWords(s);
        c.wordMasks = words.map(caseMaskOf);
        return s.toLowerCase();
      },
      putl: (target: V, _s: V, c: CaseComplement) => {
        const { words, seps } = parseWords(target);
        const cased = words.map((w, i) => {
          const mask = i < c.wordMasks.length ? c.wordMasks[i]! : "";
          return mask.length === 0 ? w : applyCasePattern(w, mask);
        });
        return rebuildWords(cased, seps);
      },
    });
  }

  /** Uppercase view. Dual of `lowercase`. */
  uppercase(): Writable<Str> {
    return Str.lens(this, {
      missing: { wordMasks: [] } as CaseComplement,
      putr: (s: V, c: CaseComplement) => {
        const { words } = parseWords(s);
        c.wordMasks = words.map(caseMaskOf);
        return s.toUpperCase();
      },
      putl: (target: V, _s: V, c: CaseComplement) => {
        const { words, seps } = parseWords(target);
        const cased = words.map((w, i) => {
          const mask = i < c.wordMasks.length ? c.wordMasks[i]! : "";
          return mask.length === 0 ? w : applyCasePattern(w, mask);
        });
        return rebuildWords(cased, seps);
      },
    });
  }

  /** Words view, one word per line.
   *
   *  Read: split on non-word characters, join with `\n`.
   *  Complement: the separator layout (lead, between-each, trail).
   *  Write: split the new line-separated target into words, rebuild
   *  the source with the original separators. Adding words inserts
   *  single spaces; removing words preserves the trailing separator. */
  words(): Writable<Str> {
    return Str.lens(this, {
      missing: { separators: [] } as WordsComplement,
      putr: (s: V, c: WordsComplement) => {
        const { words, seps } = parseWords(s);
        c.separators = seps;
        return words.join("\n");
      },
      putl: (target: V, _s: V, c: WordsComplement) => {
        // Editing in this pane treats each line as one word — empty
        // lines and per-line whitespace are dropped, mirroring the
        // forward map. Punctuation typed into a line stays as part of
        // that word; it'll round-trip through parseWords if it sticks.
        const words = target
          .split(/\n/)
          .map(w => w.trim())
          .filter(w => w.length > 0);
        return rebuildWords(words, c.separators);
      },
    });
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
    return Str.lens(this, {
      missing: {
        positions: [],
        unique: [],
        separators: [],
        sourceWords: [],
      } as SortedUniqueComplement,
      putr: (s: V, c: SortedUniqueComplement) => {
        const { words, seps } = parseWords(s);
        c.separators = seps;
        c.sourceWords = words;
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
        c.unique = unique;
        c.positions = unique.map(k => buckets.get(k)!);
        return unique.join("\n");
      },
      putl: (target: V, _s: V, c: SortedUniqueComplement) => {
        const edited = target
          .split(/\n/)
          .map(w => w.trim())
          .filter(w => w.length > 0);
        const sourceWords = c.sourceWords.slice();
        const n = Math.min(edited.length, c.unique.length);
        for (let i = 0; i < n; i++) {
          const newWord = edited[i]!;
          const positions = c.positions[i]!;
          for (const { index, sourceCase } of positions) {
            if (index >= sourceWords.length) continue;
            sourceWords[index] = applyCasePattern(newWord, caseMaskOf(sourceCase));
          }
        }
        return rebuildWords(sourceWords, c.separators);
      },
    });
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
