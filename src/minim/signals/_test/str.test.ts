// str.test.ts — Str runtime + symmetric lens laws.
//
// Coverage (designed to try hard to break the engine):
//   - str() factory, basic reads / writes / equality
//   - reverse() / rot13() — isomorphic involutions (classical laws)
//   - trim() — symmetric: complement = leading + trailing whitespace
//   - lowercase() / uppercase() — symmetric: case mask preserved
//   - words() — symmetric: separator pattern preserved
//   - sortedUnique() — symmetric: multi-position broadcast w/ case mask
//   - Chained symmetric lenses: trim().lowercase().words()...
//   - Lens-on-symmetric fusion: trim().rot13() rides _fuseOnSymmetric
//   - Multiple lenses sharing a parent — independent complements
//   - Effect tracking through symmetric chains
//   - Pathological / Unicode / empty / very-long inputs
//   - Lens laws (GetPut, PutGet, PutPut) for every projection
//   - Read stability — repeated reads yield the same value
//   - Recovery — write degenerate value, then a non-degenerate one

import { describe, expect, it } from "vitest";
import { effect, isLens } from "../signal";
import { Num } from "../values/num";
import {
  applyCaseMask,
  caseMaskOf,
  parseWords,
  rebuildWords,
  reverseStr,
  rot13Str,
  Str,
  str,
} from "../values/str";
import {
  approxNumber,
  type SourceAndLens,
  verifyGetPut,
  verifyLensLaws,
  verifyPutGet,
  verifyPutPut,
  verifyReadStability,
  verifyRecovery,
} from "./_laws";

const strEq = (a: string, b: string) => a === b;

// Random string generators used by the law verifiers.
const rngChar = (): string => {
  const r = Math.random();
  if (r < 0.5) return String.fromCharCode(97 + Math.floor(Math.random() * 26));
  if (r < 0.8) return String.fromCharCode(65 + Math.floor(Math.random() * 26));
  if (r < 0.9) return " ";
  return ".,!?;:\n\t-_()[]"[Math.floor(Math.random() * 15)]!;
};
const rngString = (len = 16): string => {
  let s = "";
  for (let i = 0; i < len; i++) s += rngChar();
  return s;
};
const rngWord = (): string => {
  const len = 1 + Math.floor(Math.random() * 6);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return s;
};

// ─── Factory ──────────────────────────────────────────────────────

describe("str() factory", () => {
  it("seeds a writable cell from a literal", () => {
    const s = str("hello");
    expect(s).toBeInstanceOf(Str);
    expect(s.value).toBe("hello");
    s.value = "world";
    expect(s.value).toBe("world");
  });

  it("identity-passes an existing Writable<Str>", () => {
    const a = str("a");
    expect(str(a)).toBe(a);
  });

  it("default is the empty string", () => {
    expect(str().value).toBe("");
  });
});

// ─── Pure isomorphisms ────────────────────────────────────────────

describe("Str.reverse() / Str.rot13()", () => {
  it("reverse is involutive", () => {
    const s = str("Hello, World!");
    const r = s.reverse();
    expect(r.value).toBe("!dlroW ,olleH");
    expect(s.reverse().reverse().value).toBe("Hello, World!");
  });

  it("rot13 is involutive", () => {
    const s = str("Hello");
    expect(s.rot13().value).toBe("Uryyb");
    expect(s.rot13().rot13().value).toBe("Hello");
  });

  it("reverse is writable — writes propagate to source", () => {
    const s = str("abc");
    const r = s.reverse();
    expect(isLens(r)).toBe(true);
    r.value = "xyz";
    expect(s.value).toBe("zyx");
  });

  it("rot13 is writable — writes are inverse-encoded back", () => {
    const s = str("Hello");
    const r = s.rot13();
    r.value = "Uryyb"; // rot13 of "Hello"
    expect(s.value).toBe("Hello");
    r.value = "test";
    expect(s.value).toBe("grfg");
  });

  it("reverse() — full lens laws", () => {
    verifyLensLaws(
      () => {
        const s = str(rngString(10));
        return { source: s, lens: s.reverse() };
      },
      () => rngString(10),
    );
  });

  it("rot13() — full lens laws", () => {
    verifyLensLaws(
      () => {
        const s = str(rngString(12));
        return { source: s, lens: s.rot13() };
      },
      () => rngString(12),
    );
  });

  it("preserves Unicode through reverse", () => {
    const s = str("café résumé");
    const r = s.reverse();
    expect(r.value).toBe("émusér éfac");
    r.value = "émusér éfac";
    expect(s.value).toBe("café résumé");
  });
});

// ─── trim() — leading/trailing whitespace complement ──────────────

describe("Str.trim()", () => {
  it("reads trimmed value", () => {
    const s = str("  Hello  ");
    expect(s.trim().value).toBe("Hello");
  });

  it("writes preserve original padding", () => {
    const s = str("  Hello  ");
    const t = s.trim();
    t.peek(); // realize complement
    t.value = "World";
    expect(s.value).toBe("  World  ");
  });

  it("preserves tab/newline padding", () => {
    const s = str("\t\n  hi  \t");
    const t = s.trim();
    expect(t.value).toBe("hi");
    t.value = "bye";
    expect(s.value).toBe("\t\n  bye  \t");
  });

  it("no whitespace → trim is identity", () => {
    const s = str("hello");
    const t = s.trim();
    expect(t.value).toBe("hello");
    t.value = "world";
    expect(s.value).toBe("world");
  });

  it("handles all-whitespace input — lead consumes everything", () => {
    const s = str("   ");
    const t = s.trim();
    expect(t.value).toBe("");
    t.value = "hi";
    // The complement captured lead="   ", trail="", so we get "   hi".
    expect(s.value).toBe("   hi");
  });

  it("handles empty string", () => {
    const s = str("");
    const t = s.trim();
    expect(t.value).toBe("");
    t.value = "x";
    expect(s.value).toBe("x");
  });

  it("PutGet — read after write returns the written value", () => {
    verifyPutGet(
      () => {
        const s = str(`  ${rngWord()}  `);
        return { source: s, lens: s.trim() };
      },
      () => rngWord(),
      { viewEq: strEq },
    );
  });

  it("GetPut — writing back the read is a no-op on source", () => {
    verifyGetPut(
      () => {
        const s = str(`  ${rngWord()}  `);
        const lens = s.trim();
        lens.peek(); // realize complement on first read
        return { source: s, lens };
      },
      { sourceEq: strEq },
    );
  });

  it("PutPut — only the last write survives", () => {
    verifyPutPut(
      () => {
        const s = str(`  ${rngWord()}  `);
        const lens = s.trim();
        lens.peek();
        return { source: s, lens };
      },
      () => rngWord(),
      { sourceEq: strEq },
    );
  });

  it("read stability — 5 reads in a row yield the same value", () => {
    verifyReadStability(
      () => {
        const s = str("  hi  ");
        return { source: s, lens: s.trim() };
      },
      { viewEq: strEq, sourceEq: strEq, reads: 5 },
    );
  });

  it("recovery — collapse to empty, then back to non-empty restores padding", () => {
    verifyRecovery(
      () => {
        const s = str("  hi  ");
        return { source: s, lens: s.trim() };
      },
      "",
      "back",
      _orig => "  back  ",
      { sourceEq: strEq },
    );
  });
});

// ─── lowercase() — case-mask complement ───────────────────────────

describe("Str.lowercase() (case-preserving find/replace)", () => {
  it("reads lowercased value", () => {
    const s = str("Hello World");
    expect(s.lowercase().value).toBe("hello world");
  });

  it("write preserves source casing — Foster headline", () => {
    const s = str("Hello World");
    const lo = s.lowercase();
    lo.peek(); // realize mask
    lo.value = "world fox";
    // Word masks for ["Hello", "World"] are [Title, Title]; written
    // words ["world", "fox"] gain title case at the same word index.
    expect(s.value).toBe("World Fox");
  });

  it("mixed-case write through lowercase view preserves per-word case", () => {
    const s = str("Quick BROWN fox");
    const lo = s.lowercase();
    expect(lo.value).toBe("quick brown fox");
    lo.value = "happy purple cat";
    // Word 0 "Quick" → title case; word 1 "BROWN" → ALL CAPS;
    // word 2 "fox" → lowercase. Applied to ["happy","purple","cat"].
    expect(s.value).toBe("Happy PURPLE cat");
  });

  it("longer write — word-aware case applies to the whole new word", () => {
    const s = str("Hi");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "hello!";
    // "Hi" word mask = Title (U then L). Applied to "hello" word → "Hello".
    // The "!" is a separator, retained as-is.
    expect(s.value).toBe("Hello!");
  });

  it("shorter write — mask of word i applies to new word i", () => {
    const s = str("HELLO");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "bye";
    expect(s.value).toBe("BYE");
  });

  it("punctuation positions are separators — only word characters get cased", () => {
    const s = str("Hi!");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "go?";
    // Word 0 "Hi" → Title; applied to "go" → "Go". "?" is the trailing
    // separator from "go?".
    expect(s.value).toBe("Go?");
  });

  it("user can add words past the original — overflow words keep target case", () => {
    const s = str("Hello");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "world fox cat";
    // Only word 0 has a mask (Title); words 1, 2 fall through as-is.
    expect(s.value).toBe("World fox cat");
  });

  it("PutGet", () => {
    verifyPutGet(
      () => {
        const s = str(rngString(10));
        return { source: s, lens: s.lowercase() };
      },
      () => rngString(10).toLowerCase(),
      { viewEq: strEq },
    );
  });

  it("GetPut", () => {
    verifyGetPut(
      () => {
        const s = str(rngString(10));
        const lens = s.lowercase();
        lens.peek();
        return { source: s, lens };
      },
      { sourceEq: strEq },
    );
  });

  it("PutPut", () => {
    verifyPutPut(
      () => {
        const s = str(rngString(8));
        const lens = s.lowercase();
        lens.peek();
        return { source: s, lens };
      },
      () => rngString(8).toLowerCase(),
      { sourceEq: strEq },
    );
  });

  it("read stability", () => {
    verifyReadStability(
      () => {
        const s = str("ABCdef");
        return { source: s, lens: s.lowercase() };
      },
      { viewEq: strEq, sourceEq: strEq, reads: 5 },
    );
  });
});

// ─── uppercase() — symmetrical to lowercase ───────────────────────

describe("Str.uppercase()", () => {
  it("reads uppercased", () => {
    expect(str("Hello").uppercase().value).toBe("HELLO");
  });

  it("write preserves source casing", () => {
    const s = str("Hello World");
    const up = s.uppercase();
    up.peek();
    up.value = "WORLD FOX";
    expect(s.value).toBe("World Fox");
  });

  it("lens laws", () => {
    verifyLensLaws(
      () => {
        const s = str(rngString(8));
        return { source: s, lens: s.uppercase() };
      },
      () => rngString(8).toUpperCase(),
      { viewEq: strEq, sourceEq: strEq },
    );
  });
});

// ─── words() — separator-preserving complement ────────────────────

describe("Str.words()", () => {
  it("reads as one word per line", () => {
    const s = str("  The Quick Brown Fox");
    expect(s.words().value).toBe("The\nQuick\nBrown\nFox");
  });

  it("preserves separators on write", () => {
    const s = str("  The Quick Brown");
    const w = s.words();
    w.peek();
    w.value = "the\nquick\nbrown";
    expect(s.value).toBe("  the quick brown");
  });

  it("preserves complex separators (tabs / multiple spaces / punctuation)", () => {
    const s = str("  hello,\tworld!");
    const w = s.words();
    w.peek();
    w.value = "bye\nworld";
    expect(s.value).toBe("  bye,\tworld!");
  });

  it("preserves trailing punctuation when shortening word list", () => {
    const s = str("hello world.");
    const w = s.words();
    w.peek();
    w.value = "hi";
    expect(s.value).toBe("hi.");
  });

  it("inserts spaces for added words past the original count", () => {
    const s = str("hello world");
    const w = s.words();
    w.peek();
    w.value = "a\nb\nc\nd";
    // Original sep[1]=" "; the rest fall back to " ".
    expect(s.value).toBe("a b c d");
  });

  it("empty input round-trips", () => {
    const s = str("");
    const w = s.words();
    expect(w.value).toBe("");
    w.value = "";
    expect(s.value).toBe("");
  });

  it("whitespace-only input — words view is empty", () => {
    const s = str("   ");
    const w = s.words();
    expect(w.value).toBe("");
    w.value = "hi";
    // 0-word source: the single sep entry is treated as lead only —
    // not double-counted as trail (`rebuildWords` collapse rule).
    expect(s.value).toBe("   hi");
  });

  it("GetPut", () => {
    verifyGetPut(
      () => {
        const s = str("  The Quick Brown");
        const lens = s.words();
        lens.peek();
        return { source: s, lens };
      },
      { sourceEq: strEq },
    );
  });

  it("PutGet — assuming written value is in canonical form", () => {
    verifyPutGet(
      () => {
        const s = str("  The Quick Brown");
        const lens = s.words();
        lens.peek();
        return { source: s, lens };
      },
      () => Array.from({ length: 3 }, () => rngWord()).join("\n"),
      { viewEq: strEq },
    );
  });

  it("read stability", () => {
    verifyReadStability(
      () => {
        const s = str("hello world fox");
        return { source: s, lens: s.words() };
      },
      { viewEq: strEq, sourceEq: strEq, reads: 5 },
    );
  });
});

// ─── sortedUnique() — multi-position broadcast w/ case mask ───────

describe("Str.sortedUnique()", () => {
  it("reads sorted unique lowercase", () => {
    const s = str("the quick brown fox jumps over the lazy dog");
    const u = s.sortedUnique();
    expect(u.value.split("\n").sort()).toEqual(
      ["brown", "dog", "fox", "jumps", "lazy", "over", "quick", "the"].sort(),
    );
  });

  it("dedupes case-insensitively but the SOURCE keeps each occurrence's case", () => {
    const s = str("The the THE");
    const u = s.sortedUnique();
    expect(u.value).toBe("the");
  });

  it("writing one entry broadcasts to ALL occurrences with original case", () => {
    const s = str("The quick The brown the");
    const u = s.sortedUnique();
    u.peek();
    // Replace "the" everywhere — should arrive as "The", "The", "the".
    u.value = ["cat", "quick", "brown"].sort().join("\n");
    // unique sorted alphabetically: brown, cat, quick. Replacing each:
    //   brown → "quick" (mask of source's "brown")
    //   cat   → "brown" (replaces "the" with "cat" then mask preserves "The"/"The"/"the")
    // To make the test deterministic, write each entry explicitly:
    u.value = "cat\nquick\nbrown";
    // After sort, the unique list was [brown, quick, the]. Pos 0 → brown
    // → maps to source word index 3 ("brown"); pos 1 → quick → source[1]
    // ("quick"); pos 2 → the → source[0,2,4] ("The","The","the").
    // We wrote ["cat","quick","brown"] in that sorted-list order.
    // So: source[3]="cat" (mask of "brown" = LLLLL → "cat" lowercase)
    //     source[1]="quick" (no change), source[0,2,4]: replace "the" →
    //     "brown" applied with case mask. Source[0]="The"→mask ULL applied
    //     to "brown" → "Brown". Same for source[2]. Source[4]="the"→"brown".
    expect(s.value).toBe("Brown quick Brown cat brown");
  });

  it("preserves separators and per-position case when broadcasting", () => {
    const s = str("  The...the,The");
    const u = s.sortedUnique();
    u.peek();
    // "the" appears 3 times in source — at positions 0 ("The"), 1
    // ("the"), 2 ("The"). Writing "x" through the deduped view
    // broadcasts to all three, each rebuilt with the source's case
    // pattern: title → "X", lower → "x", title → "X".
    u.value = "x";
    expect(s.value).toBe("  X...x,X");
  });

  it("read stability", () => {
    verifyReadStability(
      () => {
        const s = str("hello world foo bar hello");
        return { source: s, lens: s.sortedUnique() };
      },
      { viewEq: strEq, sourceEq: strEq, reads: 5 },
    );
  });

  it("GetPut", () => {
    verifyGetPut(
      () => {
        const s = str("hello world foo bar hello");
        const lens = s.sortedUnique();
        lens.peek();
        return { source: s, lens };
      },
      { sourceEq: strEq },
    );
  });
});

// ─── Chained symmetric lenses ─────────────────────────────────────

describe("Chained symmetric lenses", () => {
  it("trim ▶ lowercase: writes propagate through both layers", () => {
    const s = str("  Hello World  ");
    const trimmed = s.trim();
    const lo = trimmed.lowercase();
    trimmed.peek();
    lo.peek();
    expect(lo.value).toBe("hello world");
    lo.value = "world fox";
    // lo→trim layer: applies mask "ULLLL ULLLL" to "world fox" → "World Fox"
    // trim→source: restores "  " lead and "  " trail
    expect(s.value).toBe("  World Fox  ");
  });

  it("trim ▶ lowercase ▶ words ▶ sortedUnique", () => {
    const s = str("  The Quick Brown The  ");
    const trimmed = s.trim();
    const lo = trimmed.lowercase();
    const w = lo.words();
    const u = w.sortedUnique();
    // Realize complements top-down
    trimmed.peek();
    lo.peek();
    w.peek();
    u.peek();
    expect(u.value).toBe(["brown", "quick", "the"].join("\n"));
    // Edit through the deepest layer
    u.value = "fox\nslow\nthe"; // brown→fox, quick→slow, the→the
    // Should propagate ALL the way to source with the original casing
    // and padding preserved.
    expect(s.value).toBe("  The Slow Fox The  ");
  });

  it("rot13 fuses on top of trim (lens-on-symmetric)", () => {
    const s = str("  Hello  ");
    const r = s.trim().rot13();
    r.peek();
    expect(r.value).toBe("Uryyb");
    r.value = "Uryyb"; // = rot13("Hello"); writes through trim too
    expect(s.value).toBe("  Hello  "); // unchanged: PutGet via complement
  });

  it("reverse fuses on top of lowercase", () => {
    const s = str("Hello");
    const r = s.lowercase().reverse();
    r.peek();
    expect(r.value).toBe("olleh");
    r.value = "dlrow";
    // reverse→lowercase: "dlrow" reversed = "world"; case mask of "Hello"
    // = ULLLL applied to "world" → "World"
    expect(s.value).toBe("World");
  });

  it("two independent lenses on the same source don't corrupt complements", () => {
    const s = str("  Hello World  ");
    const t = s.trim();
    const lo = s.lowercase();
    t.peek();
    lo.peek();
    t.value = "Bye";
    expect(s.value).toBe("  Bye  ");
    // lo's mask captured pre-edit: "  Hello World  " → mask " ULLLLULL ".
    // After s changes to "  Bye  ", lo.value reads off the NEW source and
    // refreshes the mask. So:
    expect(lo.value).toBe("  bye  ");
    lo.value = "  fox  ";
    // The new mask is for "  Bye  " → "  ULL  ", applied to "  fox  " →
    //   "  Fox  ". Source updates accordingly.
    expect(s.value).toBe("  Fox  ");
  });
});

// ─── Effect tracking through symmetric chains ─────────────────────

describe("Effects subscribe to symmetric chains", () => {
  it("effect fires when source changes (through trim view)", () => {
    const s = str("  hi  ");
    const t = s.trim();
    let last = t.value;
    let fires = 0;
    const dispose = effect(() => {
      last = t.value;
      fires++;
    });
    fires = 0;
    s.value = "  bye  ";
    expect(last).toBe("bye");
    expect(fires).toBe(1);
    dispose();
  });

  it("effect fires when written through a chained view", () => {
    const s = str("  Hello  ");
    const lo = s.trim().lowercase();
    lo.peek(); // realize complements before subscribing
    let last = lo.value;
    let fires = 0;
    const dispose = effect(() => {
      last = lo.value;
      fires++;
    });
    fires = 0;
    lo.value = "world";
    expect(last).toBe("world");
    expect(fires).toBe(1);
    dispose();
  });
});

// ─── Pathological inputs ──────────────────────────────────────────

describe("Pathological inputs", () => {
  it("very long string (10k chars) — trim round-trip", () => {
    const body = "a".repeat(10000);
    const padded = `   ${body}   `;
    const s = str(padded);
    const t = s.trim();
    expect(t.value.length).toBe(10000);
    t.value = "x".repeat(10000);
    expect(s.value.length).toBe(10006); // 3 + 10000 + 3
    expect(s.value.startsWith("   ") && s.value.endsWith("   ")).toBe(true);
  });

  it("Unicode characters — lowercase view (word-aware)", () => {
    const s = str("Café Résumé");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "happy purple";
    // Each source word has a title-case pattern (first letter upper,
    // rest lower — non-ASCII positions count as non-letters in mask
    // detection but the pattern is still title). Per-word write applies
    // title case to each target word.
    expect(s.value).toBe("Happy Purple");
  });

  it("Unicode in words view — words are letters by Unicode (\\p{L})", () => {
    const s = str("café résumé naïve");
    const w = s.words();
    expect(w.value).toBe("café\nrésumé\nnaïve");
    w.value = "fox\ndog\nbat";
    expect(s.value).toBe("fox dog bat");
  });

  it("empty string survives every projection", () => {
    const s = str("");
    expect(s.trim().value).toBe("");
    expect(s.lowercase().value).toBe("");
    expect(s.uppercase().value).toBe("");
    expect(s.words().value).toBe("");
    expect(s.sortedUnique().value).toBe("");
    expect(s.reverse().value).toBe("");
    expect(s.rot13().value).toBe("");
  });
});

// ─── Utility functions (parseWords / rebuildWords / case mask) ────

describe("utility functions", () => {
  it("parseWords / rebuildWords round-trip", () => {
    const cases = [
      "",
      "hello",
      "  hello",
      "hello  ",
      "  hello world  ",
      "hello,\tworld!",
      "  The Quick Brown Fox  ",
      "Hi.",
      "no-trail",
      "   ",
      "...",
      "a.b.c",
    ];
    for (const s of cases) {
      const { words, seps } = parseWords(s);
      expect(rebuildWords(words, seps)).toBe(s);
    }
  });

  it("caseMaskOf is length-preserving and uses U/L/space alphabet", () => {
    expect(caseMaskOf("Hi!")).toBe("UL ");
    expect(caseMaskOf("ABC")).toBe("UUU");
    expect(caseMaskOf("abc")).toBe("LLL");
    expect(caseMaskOf("a B c")).toBe("L U L");
  });

  it("applyCaseMask preserves overflow when target > mask", () => {
    expect(applyCaseMask("hello world", "UL")).toBe("Hello world");
  });

  it("reverseStr / rot13Str are involutive", () => {
    const s = "Hello, World 123!";
    expect(reverseStr(reverseStr(s))).toBe(s);
    expect(rot13Str(rot13Str(s))).toBe(s);
  });
});

// ─── Recovery (after writing through a degenerate intermediate) ───

describe("Recovery from degenerate writes", () => {
  it('trim → "" → "x" produces "  x  " (lead/trail preserved)', () => {
    verifyRecovery(
      () => {
        const s = str("  hello  ");
        return { source: s, lens: s.trim() };
      },
      "",
      "x",
      _orig => "  x  ",
      { sourceEq: strEq },
    );
  });

  it('lowercase → "" → "foo" applies the source mask to non-empty positions only', () => {
    verifyRecovery(
      () => {
        const s = str("HELLO");
        return { source: s, lens: s.lowercase() };
      },
      "",
      "foo",
      _orig => "FOO",
      { sourceEq: strEq },
    );
  });
});

// ─── Stress — really try to break the engine ──────────────────────

describe("Stress: try to break the symmetric chain", () => {
  it("random walk of 100 writes through a 4-deep chain leaves source coherent", () => {
    const s = str("  Hello World  ");
    const t = s.trim();
    const lo = t.lowercase();
    const w = lo.words();
    const u = w.sortedUnique();
    // Realize complements top-down.
    t.peek();
    lo.peek();
    w.peek();
    u.peek();

    // 100 random writes to a random layer; nothing should NaN, throw,
    // or stall.
    const layers: { value: string }[] = [s, t, lo, w, u];
    for (let i = 0; i < 100; i++) {
      const layer = layers[Math.floor(Math.random() * layers.length)]!;
      layer.value = rngString(8);
      // Source remains a string of finite length.
      expect(typeof s.value).toBe("string");
    }
    // After 100 random writes the chain still reads cleanly.
    expect(typeof u.value).toBe("string");
  });

  it("self-write inside an effect (through a chained view) is bounded", () => {
    const s = str("Hello");
    const lo = s.lowercase();
    let fires = 0;
    const dispose = effect(() => {
      fires++;
      const v = lo.value;
      if (fires < 50 && v.length > 0 && !/^x/.test(v)) {
        // Trim a char off until it starts with 'x', or give up.
        lo.value = v.replace(/./, "x");
      }
    });
    expect(fires).toBeLessThan(200);
    dispose();
  });

  it("five lenses on one source — independent complements", () => {
    const s = str("  Hello World  ");
    const t = s.trim();
    const lo = s.lowercase();
    const up = s.uppercase();
    const w = s.words();
    const u = s.sortedUnique();
    t.peek();
    lo.peek();
    up.peek();
    w.peek();
    u.peek();

    expect(t.value).toBe("Hello World");
    expect(lo.value).toBe("  hello world  "); // lowercases entire source incl. padding
    expect(up.value).toBe("  HELLO WORLD  ");
    expect(w.value).toBe("Hello\nWorld");
    expect(u.value.split("\n").sort()).toEqual(["hello", "world"]);

    // Write through one — others reflect the new source on re-read.
    t.value = "Bye Fox";
    expect(s.value).toBe("  Bye Fox  ");
    expect(lo.value).toBe("  bye fox  ");
    expect(up.value).toBe("  BYE FOX  ");
    expect(w.value).toBe("Bye\nFox");
  });

  it("repeated identical writes don't accumulate complement state", () => {
    const s = str("  Hello  ");
    const t = s.trim();
    t.peek();
    for (let i = 0; i < 1000; i++) t.value = "Hello";
    expect(s.value).toBe("  Hello  ");
  });

  it("read stability under interleaved writes — no read side effects", () => {
    const s = str("  Hello World  ");
    const lo = s.trim().lowercase();
    lo.peek();
    const a = lo.value;
    const b = lo.value;
    const c = lo.value;
    expect(a).toBe(b);
    expect(b).toBe(c);
    // Source should be unchanged by reads.
    expect(s.value).toBe("  Hello World  ");
  });

  it("rot13 fused on a symmetric receiver — round-trip exact", () => {
    const s = str("  Hello  ");
    const r = s.trim().rot13();
    r.peek();
    // ROT13 is involutive; writing back the same value preserves the
    // source verbatim (including complements that preserve the padding).
    const seen = r.value;
    r.value = seen;
    expect(s.value).toBe("  Hello  ");
  });

  it("very many words — sortedUnique survives", () => {
    // 100-word source with heavy duplication.
    const words = Array.from({ length: 100 }, (_, i) =>
      i % 5 === 0 ? "Alpha" : i % 3 === 0 ? "Beta" : "gamma",
    );
    const s = str(words.join(" "));
    const u = s.sortedUnique();
    expect(u.value.split("\n").sort()).toEqual(["alpha", "beta", "gamma"]);
    u.value = "x\ny\nz";
    // All occurrences are replaced. Counts:
    //   "alpha" was 20 occurrences (indices 0, 5, 10, …) — replaced by "x"
    //   "beta" — replaced by "y"
    //   "gamma" — replaced by "z"
    // Sorted alphabetical: alpha → x, beta → y, gamma → z.
    const parts = s.value.split(" ");
    expect(parts).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      const original = i % 5 === 0 ? "Alpha" : i % 3 === 0 ? "Beta" : "gamma";
      const expected = original === "Alpha" ? "X" : original === "Beta" ? "Y" : "z";
      expect(parts[i]).toBe(expected);
    }
  });

  it("alternating writes between source and view stay consistent", () => {
    const s = str("  Hello  ");
    const t = s.trim();
    t.peek();
    s.value = "  World  ";
    expect(t.value).toBe("World");
    t.value = "Fox";
    expect(s.value).toBe("  Fox  ");
    s.value = "\t\nCat\t\n";
    expect(t.value).toBe("Cat");
    t.value = "Dog";
    expect(s.value).toBe("\t\nDog\t\n");
  });

  it("RO derivation off a symmetric chain — read tracks without writes", () => {
    const s = str("  Hello World  ");
    const lo = s.trim().lowercase();
    const len = Num.derive(() => lo.value.length);
    expect(len.value).toBe(11);
    s.value = "  Hi  ";
    expect(len.value).toBe(2);
  });
});

// ─── Source for the verifier helpers that test source compat ─────

interface StrSourceAndLens extends SourceAndLens<string, string> {}
void approxNumber;
void ({} as StrSourceAndLens);
