// str-properties.test.ts — property / random tests for the string
// lens projections, organised by the laws in the literature.
//
// Each describe block names a law and the lens it applies to; the body
// runs N random trials. References:
//
//   Foster, Greenwald, Moore, Pierce, Schmitt (TOPLAS 2007)
//     — classical GetPut / PutGet / PutPut.
//   Foster, Pilkiewicz, Pierce (ICFP 2008, "Quotient Lenses")
//     — laws up to source / view equivalences `≈_S`, `≈_V`.
//   Bohannon, Foster, Pierce, Pilkiewicz, Schmitt (POPL 2008, "Boomerang")
//     — dictionary / list lenses, resourceful chunk-matching.
//   Hofmann, Pierce, Wagner (POPL 2011, "Symmetric Lenses")
//     — symmetric form with complement and PutRL / PutLR round-trips.
//
// Each lens block declares an explicit ≈_S / ≈_V where applicable, then
// drives the standard verifyLensLaws / verifyGetPut / verifyPutGet /
// verifyPutPut harness with that equivalence. Extra blocks check the
// resourceful (alignment-preserving) and symmetric-specific laws that
// don't reduce to the classical three.

import { describe, expect, it } from "vitest";
import type { Writable } from "../signal";
import {
  applyCasePattern,
  caseMaskOf,
  parseWords,
  rebuildWords,
  type Str,
  str,
} from "../values/str";
import {
  type SourceAndLens,
  verifyGetPut,
  verifyLensLaws,
  verifyPutGet,
  verifyPutPut,
  verifyReadStability,
} from "./_laws";

// ─── Trial counts ────────────────────────────────────────────────

const TRIALS = 100;

// ─── Random generators ───────────────────────────────────────────

const rngInt = (lo: number, hi: number): number => lo + Math.floor(Math.random() * (hi - lo + 1));

/** Pick one character at random from a string. */
const rngChar = (chars: string): string => chars.charAt(rngInt(0, chars.length - 1));

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const PUNCT = ".,!?;:-_'";
const WS = " \t\n";
const WORD_CHARS = `${LETTERS}${DIGITS}_'-`;

/** Mixed string: ~60% letters, 10% digits, 15% punctuation, 15% whitespace. */
const rngMixed = (len: number): string => {
  let s = "";
  for (let i = 0; i < len; i++) {
    const r = Math.random();
    if (r < 0.6) s += rngChar(LETTERS);
    else if (r < 0.7) s += rngChar(DIGITS);
    else if (r < 0.85) s += rngChar(PUNCT);
    else s += rngChar(WS);
  }
  return s;
};

/** A single word: 1-8 word-chars (letters, digits, _, ', -). */
const rngWord = (): string => {
  const n = rngInt(1, 8);
  let s = "";
  for (let i = 0; i < n; i++) s += rngChar(WORD_CHARS);
  return s;
};

/** A lowercase word: 1-8 ASCII lowercase letters. */
const rngLowerWord = (): string => {
  const n = rngInt(1, 8);
  let s = "";
  for (let i = 0; i < n; i++) s += rngChar("abcdefghijklmnopqrstuvwxyz");
  return s;
};

/** A sentence-like string: N words separated by random separators
 *  (spaces, punctuation), with optional leading / trailing whitespace. */
const rngSentence = (minWords = 1, maxWords = 8): string => {
  const n = rngInt(minWords, maxWords);
  const lead = Math.random() < 0.3 ? rngChar(WS).repeat(rngInt(1, 3)) : "";
  const trail = Math.random() < 0.3 ? rngChar(WS).repeat(rngInt(1, 3)) : "";
  const seps: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    if (Math.random() < 0.7) seps.push(" ");
    else seps.push(`${rngChar(PUNCT)} `);
  }
  let s = lead;
  for (let i = 0; i < n; i++) {
    s += rngWord();
    if (i < n - 1) s += seps[i]!;
  }
  return s + trail;
};

// ─── Equivalence relations (the ≈_S / ≈_V of the literature) ─────

/** Strict equality on strings. Default ≈ for most cases. */
const strEq = (a: string, b: string) => a === b;

/** Source equivalence for `trim`: identical (we capture the EXACT
 *  lead/trail in the complement, so writes round-trip strictly). */
const trimSourceEq = strEq;

/** View equivalence for `trim`: identical (the view's domain is "no
 *  edge whitespace"; we strip edges in `putl`). */
const trimViewEq = strEq;

/** View equivalence for `lowercase`: identical (we enforce the
 *  view's domain by lowering the SOURCE in `putr`, but the user can
 *  write any case via the textarea — strict viewEq holds only on
 *  lowercase inputs). The property tests below restrict the view
 *  generator to lowercase strings so strict equality applies. */
const lowerViewEq = strEq;

/** View equivalence for `words`: identical (the view's domain is
 *  newline-separated word tokens; we enforce by stripping non-word
 *  chars per line in `putl`). */
const wordsViewEq = strEq;

// ─── Helpers: wrap a Writable<Str> as a SourceAndLens ────────────

const makeLens = <V>(
  s: Writable<Str>,
  lens: { value: V; peek(): V },
): SourceAndLens<string, V> => ({
  source: {
    get value(): string {
      return s.peek();
    },
    set value(v: string) {
      s.value = v;
    },
    peek(): string {
      return s.peek();
    },
  },
  lens,
});

// ─── ISO lenses: strict laws hold ────────────────────────────────

describe("PROPERTY: rot13 — strict GetPut / PutGet / PutPut (involution)", () => {
  it("classical laws over random mixed strings", () => {
    verifyLensLaws(
      () => {
        const s = str(rngMixed(rngInt(0, 20)));
        return makeLens(s, s.rot13());
      },
      () => rngMixed(rngInt(0, 20)),
      { trials: TRIALS, sourceEq: strEq, viewEq: strEq },
    );
  });

  it("involution: rot13(rot13(s)) = s for random inputs", () => {
    for (let i = 0; i < TRIALS; i++) {
      const v = rngMixed(rngInt(0, 30));
      const s = str(v);
      const r = s.rot13();
      r.peek();
      expect(r.rot13().value).toBe(v);
    }
  });
});

describe("PROPERTY: reverse — strict GetPut / PutGet / PutPut (involution)", () => {
  it("classical laws over random mixed strings", () => {
    verifyLensLaws(
      () => {
        const s = str(rngMixed(rngInt(0, 20)));
        return makeLens(s, s.reverse());
      },
      () => rngMixed(rngInt(0, 20)),
      { trials: TRIALS, sourceEq: strEq, viewEq: strEq },
    );
  });

  it("involution: reverse(reverse(s)) = s for random inputs", () => {
    for (let i = 0; i < TRIALS; i++) {
      const v = rngMixed(rngInt(0, 30));
      const s = str(v);
      const r = s.reverse();
      r.peek();
      expect(r.reverse().value).toBe(v);
    }
  });
});

// ─── trim: domain-closed projection ──────────────────────────────

describe("PROPERTY: trim — classical laws within view domain", () => {
  it("GetPut over random padded sentences", () => {
    verifyGetPut(
      () => {
        const s = str(rngSentence());
        const t = s.trim();
        t.peek();
        return makeLens(s, t);
      },
      { trials: TRIALS, sourceEq: trimSourceEq },
    );
  });

  it("PutGet over random no-edge strings (the view's domain)", () => {
    verifyPutGet(
      () => {
        const s = str(rngSentence());
        const t = s.trim();
        t.peek();
        return makeLens(s, t);
      },
      // Domain generator: no leading/trailing whitespace.
      () => {
        const v = rngSentence();
        return v.replace(/^\s+|\s+$/g, "");
      },
      { trials: TRIALS, viewEq: trimViewEq },
    );
  });

  it("PutPut over random no-edge strings", () => {
    verifyPutPut(
      () => {
        const s = str(rngSentence());
        const t = s.trim();
        t.peek();
        return makeLens(s, t);
      },
      () => rngSentence().replace(/^\s+|\s+$/g, ""),
      { trials: TRIALS, sourceEq: trimSourceEq },
    );
  });

  it("read stability: 5 consecutive reads yield the same value", () => {
    verifyReadStability(
      () => {
        const s = str(rngSentence());
        return makeLens(s, s.trim());
      },
      { trials: TRIALS, sourceEq: trimSourceEq, viewEq: trimViewEq, reads: 5 },
    );
  });
});

// ─── lowercase / uppercase: quotient + resourceful ───────────────

describe("PROPERTY: lowercase — quotient laws within view domain (lowercased strings)", () => {
  it("GetPut: writing back the read value preserves source", () => {
    verifyGetPut(
      () => {
        const s = str(rngSentence());
        const lo = s.lowercase();
        lo.peek();
        return makeLens(s, lo);
      },
      { trials: TRIALS, sourceEq: strEq },
    );
  });

  it("PutGet within lowercased domain", () => {
    verifyPutGet(
      () => {
        const s = str(rngSentence());
        const lo = s.lowercase();
        lo.peek();
        return makeLens(s, lo);
      },
      () => rngSentence().toLowerCase(),
      { trials: TRIALS, viewEq: lowerViewEq },
    );
  });

  it("PutPut within lowercased domain", () => {
    verifyPutPut(
      () => {
        const s = str(rngSentence());
        const lo = s.lowercase();
        lo.peek();
        return makeLens(s, lo);
      },
      () => rngSentence().toLowerCase(),
      { trials: TRIALS, sourceEq: strEq },
    );
  });
});

describe("PROPERTY: uppercase — same laws, dual", () => {
  it("GetPut, PutGet, PutPut", () => {
    verifyLensLaws(
      () => {
        const s = str(rngSentence());
        const up = s.uppercase();
        up.peek();
        return makeLens(s, up);
      },
      () => rngSentence().toUpperCase(),
      { trials: TRIALS, sourceEq: strEq, viewEq: strEq },
    );
  });
});

// ─── lowercase: resourceful / alignment preservation ─────────────
//
// These are the Boomerang chunk-matching laws — per-word case must
// survive structural edits that don't change content. Not implied by
// the classical lens laws above; these are extra and the headline
// reason the lens uses a complement at all.

describe("PROPERTY: lowercase — resourceful (per-word case preserved under structural edits)", () => {
  it("REORDER: shuffling words in lowercase view preserves each word's case BY CONTENT", () => {
    for (let i = 0; i < TRIALS; i++) {
      // Build a source where every word has a distinct case pattern.
      // We use lowercase-only words and randomly title-case some.
      const n = rngInt(2, 6);
      const sourceWords: string[] = [];
      for (let k = 0; k < n; k++) {
        const w = rngLowerWord();
        const cased =
          Math.random() < 0.5
            ? w
            : Math.random() < 0.5
              ? w.toUpperCase()
              : w.charAt(0).toUpperCase() + w.slice(1);
        sourceWords.push(cased);
      }
      // Use simple space separators so seps[i] is uniform.
      const sourceStr = sourceWords.join(" ");
      // Source words must be uniquely-keyed (no duplicates after
      // lowercasing) so the content match unambiguously locates each.
      const lowered = sourceWords.map(w => w.toLowerCase());
      if (new Set(lowered).size !== lowered.length) continue;

      const s = str(sourceStr);
      const lo = s.lowercase();
      lo.peek();
      // Shuffle.
      const order = [...Array(n).keys()].sort(() => Math.random() - 0.5);
      const reordered = order.map(i => lowered[i]!).join(" ");
      lo.value = reordered;
      // Each source position now contains the lowercased word for
      // that NEW position, cased per the ORIGINAL source word with
      // the matching content.
      const expectedSource = order.map(i => sourceWords[i]!).join(" ");
      expect(s.value).toBe(expectedSource);
    }
  });

  it("SPLIT-REJOIN: insert a space inside a word and remove it round-trips", () => {
    for (let i = 0; i < TRIALS; i++) {
      const source = rngSentence(2, 6).replace(/^\s+|\s+$/g, "");
      const s = str(source);
      const lo = s.lowercase();
      lo.peek();
      const lower = source.toLowerCase();
      // Pick a random position INSIDE a word to split.
      const splitPos = (() => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const p = rngInt(1, lower.length - 1);
          if (/[\p{L}\p{N}_'-]/u.test(lower[p - 1]!) && /[\p{L}\p{N}_'-]/u.test(lower[p]!)) {
            return p;
          }
        }
        return -1;
      })();
      if (splitPos < 0) continue;
      const split = `${lower.slice(0, splitPos)} ${lower.slice(splitPos)}`;
      lo.value = split;
      lo.value = lower;
      expect(s.value).toBe(source);
    }
  });

  it("INSERT-REMOVE: adding a new word then removing it round-trips", () => {
    for (let i = 0; i < TRIALS; i++) {
      const source = rngSentence(2, 5).replace(/^\s+|\s+$/g, "");
      const s = str(source);
      const lo = s.lowercase();
      lo.peek();
      const lower = source.toLowerCase();
      const newWord = rngLowerWord();
      const words = lower.split(/\s+/).filter(Boolean);
      const insertAt = rngInt(0, words.length);
      const inserted = [...words.slice(0, insertAt), newWord, ...words.slice(insertAt)].join(" ");
      lo.value = inserted;
      lo.value = lower;
      expect(s.value).toBe(source);
    }
  });
});

// ─── words: dictionary-list lens ─────────────────────────────────

describe("PROPERTY: words — classical laws within view domain", () => {
  it("GetPut over random sentences", () => {
    verifyGetPut(
      () => {
        const s = str(rngSentence());
        const w = s.words();
        w.peek();
        return makeLens(s, w);
      },
      { trials: TRIALS, sourceEq: strEq },
    );
  });

  it("PutGet over newline-separated word-token lists (view's domain)", () => {
    verifyPutGet(
      () => {
        const s = str(rngSentence());
        const w = s.words();
        w.peek();
        return makeLens(s, w);
      },
      () => {
        const n = rngInt(0, 6);
        if (n === 0) return "";
        return Array.from({ length: n }, () => rngLowerWord()).join("\n");
      },
      { trials: TRIALS, viewEq: wordsViewEq },
    );
  });

  it("PutPut over the view's domain", () => {
    verifyPutPut(
      () => {
        const s = str(rngSentence());
        const w = s.words();
        w.peek();
        return makeLens(s, w);
      },
      () => {
        const n = rngInt(1, 5);
        return Array.from({ length: n }, () => rngLowerWord()).join("\n");
      },
      { trials: TRIALS, sourceEq: strEq },
    );
  });
});

// ─── sortedUnique: partial dictionary lens (rename-only) ─────────
//
// The sortedUnique view supports RENAMING existing entries (broadcast
// to all matching source positions); it does NOT support adding or
// removing unique entries. The view's domain for `putl` is therefore
// "the same MULTISET of canonical keys as the current source." We
// generate writes accordingly.

describe("PROPERTY: sortedUnique — partial dictionary laws (rename-only domain)", () => {
  it("GetPut over random sentences", () => {
    verifyGetPut(
      () => {
        const s = str(rngSentence());
        const u = s.sortedUnique();
        u.peek();
        return makeLens(s, u);
      },
      { trials: TRIALS, sourceEq: strEq },
    );
  });

  it("PutGet: rename one entry, view reflects it", () => {
    for (let i = 0; i < TRIALS; i++) {
      const source = rngSentence(2, 6).replace(/^\s+|\s+$/g, "");
      const s = str(source);
      const u = s.sortedUnique();
      u.peek();
      const current = u.value;
      if (current.length === 0) continue;
      const lines = current.split("\n");
      const idx = rngInt(0, lines.length - 1);
      const newWord = rngLowerWord();
      // Avoid colliding with an existing key (would create a dupe).
      if (lines.includes(newWord)) continue;
      lines[idx] = newWord;
      u.value = lines.join("\n");
      // Read back: the renamed entry now appears at its new sorted
      // position; the others remain.
      const after = u.value.split("\n");
      expect(after.sort()).toEqual([...lines].sort());
    }
  });

  it("BROADCAST: renaming a duplicated entry updates ALL its source positions with original case", () => {
    for (let i = 0; i < TRIALS; i++) {
      // Build source with a duplicated word in different cases.
      const w = rngLowerWord();
      const others = Array.from({ length: rngInt(1, 3) }, () => rngLowerWord());
      // Ensure others don't collide with w.
      if (others.some(o => o === w)) continue;
      const cases = [w, w.charAt(0).toUpperCase() + w.slice(1), w.toUpperCase()];
      const positions = cases.slice(0, rngInt(2, 3));
      const all = [...positions, ...others].sort(() => Math.random() - 0.5);
      const source = all.join(" ");
      const s = str(source);
      const u = s.sortedUnique();
      u.peek();
      const newWord = rngLowerWord();
      if (newWord === w || others.includes(newWord)) continue;
      // Replace `w` with `newWord` in the deduped view.
      const view = u.value;
      const lines = view.split("\n").map(l => (l === w ? newWord : l));
      u.value = lines.join("\n");
      // Every original-source position where `w` appeared (in some
      // case) now has `newWord` with the SAME case pattern. The
      // canonical key matches.
      const after = s.value.split(/\s+/);
      const newPositions = positions.map(p => {
        const mask = caseMaskOf(p);
        return applyCasePattern(newWord, mask);
      });
      for (const np of newPositions) {
        expect(after).toContain(np);
      }
    }
  });
});

// ─── Symmetric round-trip laws (Hofmann/Pierce: PutRL, PutLR) ────

describe("PROPERTY: SYMMETRIC PutRL — putr ▶ putl returns source", () => {
  // For each lens: read the view, immediately write it back, source
  // should be ≈_S to the original. This is the symmetric-lens
  // "round-trip stability" condition.
  it.each([
    ["trim", (s: Writable<Str>) => s.trim()],
    ["lowercase", (s: Writable<Str>) => s.lowercase()],
    ["uppercase", (s: Writable<Str>) => s.uppercase()],
    ["words", (s: Writable<Str>) => s.words()],
    ["sortedUnique", (s: Writable<Str>) => s.sortedUnique()],
    ["rot13", (s: Writable<Str>) => s.rot13()],
    ["reverse", (s: Writable<Str>) => s.reverse()],
  ])("%s", (_name, lensFor) => {
    for (let i = 0; i < TRIALS; i++) {
      const source = rngSentence();
      const s = str(source);
      const lens = lensFor(s);
      lens.peek();
      const v = lens.value;
      lens.value = v;
      expect(s.value).toBe(source);
    }
  });
});

describe("PROPERTY: SYMMETRIC PutLR — putl ▶ putr returns view value", () => {
  // For each lens with a domain generator: write a domain-valid value,
  // then read back. Should equal what was written.
  it("rot13", () => {
    for (let i = 0; i < TRIALS; i++) {
      const s = str(rngSentence());
      const r = s.rot13();
      r.peek();
      const v = rngMixed(rngInt(0, 20));
      r.value = v;
      expect(r.value).toBe(v);
    }
  });

  it("reverse", () => {
    for (let i = 0; i < TRIALS; i++) {
      const s = str(rngSentence());
      const r = s.reverse();
      r.peek();
      const v = rngMixed(rngInt(0, 20));
      r.value = v;
      expect(r.value).toBe(v);
    }
  });

  it("trim — within view domain (no edges)", () => {
    for (let i = 0; i < TRIALS; i++) {
      const s = str(rngSentence());
      const t = s.trim();
      t.peek();
      const v = rngSentence().replace(/^\s+|\s+$/g, "");
      t.value = v;
      expect(t.value).toBe(v);
    }
  });

  it("lowercase — within view domain (lowercase only)", () => {
    for (let i = 0; i < TRIALS; i++) {
      const s = str(rngSentence());
      const lo = s.lowercase();
      lo.peek();
      const v = rngSentence().toLowerCase();
      lo.value = v;
      expect(lo.value).toBe(v);
    }
  });
});

// ─── COMPOSITION: chained lenses preserve laws ───────────────────

describe("PROPERTY: chained lenses — laws compose", () => {
  it("trim ▶ lowercase: GetPut", () => {
    verifyGetPut(
      () => {
        const s = str(rngSentence());
        const lo = s.trim().lowercase();
        lo.peek();
        return makeLens(s, lo);
      },
      { trials: TRIALS, sourceEq: strEq },
    );
  });

  it("trim ▶ lowercase ▶ words: GetPut", () => {
    verifyGetPut(
      () => {
        const s = str(rngSentence());
        const w = s.trim().lowercase().words();
        w.peek();
        return makeLens(s, w);
      },
      { trials: TRIALS, sourceEq: strEq },
    );
  });

  it("trim ▶ lowercase ▶ words ▶ sortedUnique: GetPut", () => {
    verifyGetPut(
      () => {
        const s = str(rngSentence(3, 8));
        const u = s.trim().lowercase().words().sortedUnique();
        u.peek();
        return makeLens(s, u);
      },
      { trials: TRIALS, sourceEq: strEq },
    );
  });

  it("trim ▶ rot13 (lens-on-symmetric composition): GetPut", () => {
    verifyGetPut(
      () => {
        const s = str(rngSentence());
        const r = s.trim().rot13();
        r.peek();
        return makeLens(s, r);
      },
      { trials: TRIALS, sourceEq: strEq },
    );
  });
});

// ─── DETERMINISM: same final view → same final source ────────────
//
// Convergence property — different sequences of intermediate writes
// that end at the same final view value should produce the same final
// source. Probes that the lens has no "hysteresis" beyond what the
// complement explicitly tracks.

describe("PROPERTY: determinism — different write paths converge", () => {
  it("lowercase: 5 random intermediate writes then a fixed final write", () => {
    for (let i = 0; i < TRIALS; i++) {
      const source = rngSentence(2, 5).replace(/^\s+|\s+$/g, "");
      const lower = source.toLowerCase();

      const sA = str(source);
      const loA = sA.lowercase();
      loA.peek();
      for (let k = 0; k < 5; k++) loA.value = rngSentence().toLowerCase();
      loA.value = lower;

      const sB = str(source);
      const loB = sB.lowercase();
      loB.peek();
      for (let k = 0; k < 5; k++) loB.value = rngSentence().toLowerCase();
      loB.value = lower;

      expect(sA.value).toBe(sB.value);
      // Both should be ≈_S to the original source.
      expect(sA.value).toBe(source);
    }
  });

  it("trim: any sequence of edits ending at the same trimmed value gives the same source", () => {
    for (let i = 0; i < TRIALS; i++) {
      const source = rngSentence(1, 5);
      const trimmed = source.replace(/^\s+|\s+$/g, "");

      const sA = str(source);
      const tA = sA.trim();
      tA.peek();
      for (let k = 0; k < 5; k++) tA.value = rngSentence().replace(/^\s+|\s+$/g, "");
      tA.value = trimmed;

      const sB = str(source);
      const tB = sB.trim();
      tB.peek();
      tB.value = trimmed;

      expect(sA.value).toBe(sB.value);
    }
  });
});

// ─── DOMAIN CLOSURE: putl always lands in the view's canonical form ─

describe("PROPERTY: domain closure — putl normalises arbitrary input", () => {
  // The view's image (the set of values get returns) should equal the
  // set of values getValue produces after writes. The strip-of-domain
  // logic in our `putl` enforces this.
  it("words: any input parsed back through the view is canonical", () => {
    for (let i = 0; i < TRIALS; i++) {
      const s = str(rngSentence());
      const w = s.words();
      w.peek();
      // Write an arbitrary (possibly out-of-domain) value.
      const garbage = rngMixed(rngInt(0, 20));
      w.value = garbage;
      // Read back; result must be the canonical word-per-line form.
      const v = w.value;
      // Canonical form: each line is a word-only run, no empty lines,
      // no leading/trailing whitespace per line.
      for (const line of v.split("\n")) {
        if (line.length > 0) expect(line).toMatch(/^[\p{L}\p{N}_'-]+$/u);
      }
    }
  });

  it("sortedUnique: any input parsed back is sorted, unique, word-only", () => {
    for (let i = 0; i < TRIALS; i++) {
      const s = str(rngSentence(2, 6).replace(/^\s+|\s+$/g, ""));
      const u = s.sortedUnique();
      u.peek();
      const garbage = rngMixed(rngInt(0, 20));
      u.value = garbage;
      const v = u.value;
      const lines = v.split("\n").filter(Boolean);
      for (const line of lines) expect(line).toMatch(/^[\p{L}\p{N}_'-]+$/u);
      const sorted = [...lines].sort();
      expect(lines).toEqual(sorted);
      expect(new Set(lines).size).toBe(lines.length);
    }
  });

  it("trim: any input through the view yields a no-edge string", () => {
    for (let i = 0; i < TRIALS; i++) {
      const s = str(rngSentence());
      const t = s.trim();
      t.peek();
      const garbage = rngMixed(rngInt(0, 20));
      t.value = garbage;
      const v = t.value;
      if (v.length > 0) {
        expect(/^\s/.test(v)).toBe(false);
        expect(/\s$/.test(v)).toBe(false);
      }
    }
  });
});

// ─── COMPLEMENT EQUIVALENCE: putr is idempotent after stabilisation ─

describe("PROPERTY: complement stability after putl", () => {
  // After a putl, the next putr should NOT mutate the complement (the
  // lastWriteResult identity rule). Repeated reads thereafter are
  // stable. We test this via read stability after a random write.
  it("lowercase: read stability after a random write", () => {
    for (let i = 0; i < TRIALS; i++) {
      const s = str(rngSentence());
      const lo = s.lowercase();
      lo.peek();
      lo.value = rngSentence().toLowerCase();
      const first = lo.value;
      for (let k = 0; k < 5; k++) expect(lo.value).toBe(first);
    }
  });

  it("trim: read stability after a random write", () => {
    for (let i = 0; i < TRIALS; i++) {
      const s = str(rngSentence());
      const t = s.trim();
      t.peek();
      t.value = rngSentence().replace(/^\s+|\s+$/g, "");
      const first = t.value;
      for (let k = 0; k < 5; k++) expect(t.value).toBe(first);
    }
  });
});

// ─── Utility self-tests for the generators (sanity) ─────────────

describe("PROPERTY: generators produce values matching their contracts", () => {
  it("rngWord produces only word-characters", () => {
    for (let i = 0; i < TRIALS; i++) {
      const w = rngWord();
      expect(w).toMatch(/^[\p{L}\p{N}_'-]+$/u);
    }
  });

  it("rngLowerWord produces only ASCII lowercase letters", () => {
    for (let i = 0; i < TRIALS; i++) {
      const w = rngLowerWord();
      expect(w).toMatch(/^[a-z]+$/);
    }
  });

  it("parseWords / rebuildWords round-trip identity over rngSentence", () => {
    for (let i = 0; i < TRIALS; i++) {
      const s = rngSentence();
      const { words, seps } = parseWords(s);
      expect(rebuildWords(words, seps)).toBe(s);
    }
  });
});
