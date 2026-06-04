// str-correctness.test.ts — aggressive probing of the Str projections.
//
// The goal: spell out what we WANT the laws to be, then test them
// exhaustively across the projection chain. Anything that fails here
// is either a bug we need to fix, or a subtle semantic we need to
// document. Categorised by guarantee:
//
//   1. GetPut       — read v from view, write v back, source unchanged.
//   2. PutPut       — only the last write survives.
//   3. ROUND-TRIP   — split / rejoin (or any reversible structural edit
//                     through one view) restores the original source.
//   4. STABILITY    — repeated reads converge after one putr.
//   5. ISOLATION    — multiple lenses sharing a parent don't corrupt
//                     each other's complements; an edit through one
//                     leaves the others' invariants intact.
//   6. COMPOSITION  — editing through chained projections gives
//                     consistent results regardless of which layer the
//                     edit happens at.
//   7. EXTERNAL     — an external write to the source overrides
//                     internal-edit-bias and refreshes the view's
//                     complement to reflect new content.

import { describe, expect, it } from "vitest";
import { effect } from "../signal";
import { str } from "../values/str";

// ─── 1. GetPut across each projection ─────────────────────────────

describe("GetPut: writing back the read value is a no-op on source", () => {
  it("trim", () => {
    const cases = ["  hi  ", "hello", "  ", "", "\thi\n", "x", " a b c "];
    for (const init of cases) {
      const s = str(init);
      const t = s.trim();
      t.peek();
      t.value = t.value;
      expect(s.value).toBe(init);
    }
  });

  it("lowercase", () => {
    const cases = ["Hello", "HELLO World", "abc", "Hi!", "Mixed CASE word"];
    for (const init of cases) {
      const s = str(init);
      const lo = s.lowercase();
      lo.peek();
      lo.value = lo.value;
      expect(s.value).toBe(init);
    }
  });

  it("uppercase", () => {
    const cases = ["Hello", "ALL CAPS", "abc", "Mixed CASE word"];
    for (const init of cases) {
      const s = str(init);
      const up = s.uppercase();
      up.peek();
      up.value = up.value;
      expect(s.value).toBe(init);
    }
  });

  it("words", () => {
    const cases = ["the quick brown fox", "hello, world!", "a b c", "", "   x   ", "one"];
    for (const init of cases) {
      const s = str(init);
      const w = s.words();
      w.peek();
      w.value = w.value;
      expect(s.value).toBe(init);
    }
  });

  it("sortedUnique", () => {
    const cases = ["the lazy the dog the", "Hello World", "alpha beta alpha gamma beta"];
    for (const init of cases) {
      const s = str(init);
      const u = s.sortedUnique();
      u.peek();
      u.value = u.value;
      expect(s.value).toBe(init);
    }
  });

  it("rot13", () => {
    const cases = ["Hello", "abc123XYZ", "", "x"];
    for (const init of cases) {
      const s = str(init);
      const r = s.rot13();
      r.peek();
      r.value = r.value;
      expect(s.value).toBe(init);
    }
  });
});

// ─── 2. PutPut: last write survives ───────────────────────────────

describe("PutPut: second write overrides the first", () => {
  it("trim", () => {
    const s = str("  hi  ");
    const t = s.trim();
    t.peek();
    t.value = "bye";
    t.value = "world";
    expect(s.value).toBe("  world  ");
  });

  it("lowercase: repeated different writes converge to last", () => {
    const s = str("Hello World");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "foo bar";
    lo.value = "hi bye";
    expect(s.value).toBe("Hi Bye");
  });

  it("words: repeated structural writes converge", () => {
    const s = str("a b c");
    const w = s.words();
    w.peek();
    w.value = "x";
    w.value = "p\nq\nr";
    expect(s.value).toBe("p q r");
  });
});

// ─── 3. ROUND-TRIP: structural reversible edits restore source ─────

describe("ROUND-TRIP: split / rejoin via lowercase preserves source", () => {
  it("simple 2-word: 'Hello World' split-rejoin", () => {
    const s = str("Hello World");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "hel lo world";
    lo.value = "hello world";
    expect(s.value).toBe("Hello World");
  });

  it("4-word: 'The Quick Brown Fox' split each then rejoin all", () => {
    const s = str("The Quick Brown Fox");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "th e quick brown fox";
    lo.value = "the qui ck brown fox";
    lo.value = "the quick bro wn fox";
    lo.value = "the quick brown fo x";
    lo.value = "the quick brown fox";
    expect(s.value).toBe("The Quick Brown Fox");
  });

  it("9-word pangram: split 'Jumps' does NOT lose its title case elsewhere", () => {
    // The historical wonky bug: splitting "Quick" → "q uick" shifts
    // word indices, so "Jumps" at the old index 4 finds itself paired
    // with a lowercase-mask entry from a later position, and gets
    // lower-cased in source.
    const s = str("The Quick Brown Fox Jumps over the lazy dog.");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "the q uick brown fox jumps over the lazy dog.";
    // Source after split — "Jumps" must remain capitalised.
    expect(s.value).toContain("Jumps");
    // Then rejoin.
    lo.value = "the quick brown fox jumps over the lazy dog.";
    expect(s.value).toBe("The Quick Brown Fox Jumps over the lazy dog.");
  });

  it("uppercase: 'Hello World' split-rejoin", () => {
    const s = str("Hello World");
    const up = s.uppercase();
    up.peek();
    up.value = "HEL LO WORLD";
    up.value = "HELLO WORLD";
    expect(s.value).toBe("Hello World");
  });
});

// ─── 4. STABILITY: repeated reads converge ────────────────────────

describe("STABILITY: 5 reads in a row are identical with no source side effects", () => {
  it("trim, lowercase, uppercase, words, sortedUnique, rot13", () => {
    const s = str("  The Quick Brown Fox  ");
    const lenses = [s.trim(), s.lowercase(), s.uppercase(), s.words(), s.sortedUnique(), s.rot13()];
    for (const l of lenses) {
      const sourceBefore = s.value;
      const first = l.value;
      for (let i = 0; i < 5; i++) expect(l.value).toBe(first);
      expect(s.value).toBe(sourceBefore);
    }
  });
});

// ─── 5. ISOLATION: lenses sharing a parent stay independent ───────

describe("ISOLATION: editing one lens doesn't corrupt another sharing the source", () => {
  it("lowercase, uppercase, words on the same source", () => {
    const s = str("The Quick Brown Fox");
    const lo = s.lowercase();
    const up = s.uppercase();
    const w = s.words();
    lo.peek();
    up.peek();
    w.peek();
    // Edit through lowercase.
    lo.value = "happy quick brown fox";
    expect(s.value).toBe("Happy Quick Brown Fox");
    // uppercase view should now reflect the new source.
    expect(up.value).toBe("HAPPY QUICK BROWN FOX");
    // words view also.
    expect(w.value).toBe("Happy\nQuick\nBrown\nFox");
    // Edit through uppercase.
    up.value = "HAPPY QUICK BROWN WOLF";
    expect(s.value).toBe("Happy Quick Brown Wolf");
    // lowercase view sees the change.
    expect(lo.value).toBe("happy quick brown wolf");
  });
});

// ─── 6. COMPOSITION: deep chain edits are consistent ───────────────

describe("COMPOSITION: edits through chained lenses produce equivalent results", () => {
  it("equivalent edits via lowercase or words produce same source", () => {
    // Setup A: edit via lowercase (rename one word). Peek first so the
    // complement is populated — a `putl` against a fresh, unread lens
    // has no case info yet (documented behaviour of symmetric lenses;
    // see `lastWriteResult` rule).
    const a = str("The Quick Brown Fox");
    const aLo = a.lowercase();
    aLo.peek();
    aLo.value = "the slow brown fox";
    // Setup B: edit via the deeper chain — the engine peeks parents
    // during the setter, which populates each layer's complement.
    const b = str("The Quick Brown Fox");
    b.trim().lowercase().words().value = "the\nslow\nbrown\nfox";
    expect(a.value).toBe(b.value);
  });

  it("deep chain: trim ▶ lowercase ▶ words ▶ sortedUnique reaches the same source as direct edit", () => {
    const a = str("  The Quick Brown The  ");
    const b = str("  The Quick Brown The  ");
    // Edit via deep chain.
    {
      const trimmed = a.trim();
      const lo = trimmed.lowercase();
      const w = lo.words();
      const u = w.sortedUnique();
      trimmed.peek();
      lo.peek();
      w.peek();
      u.peek();
      u.value = "brown\nquick\nthe"; // identity write
      // Source unchanged.
    }
    expect(a.value).toBe(b.value);
  });

  it("PutPut through the deep chain converges", () => {
    const s = str("  The Quick Brown The  ");
    const trimmed = s.trim();
    const lo = trimmed.lowercase();
    const w = lo.words();
    const u = w.sortedUnique();
    trimmed.peek();
    lo.peek();
    w.peek();
    u.peek();
    u.value = "fox\nslow\nthe";
    u.value = "brown\nquick\nthe"; // back to original ordering of unique words
    // Identity write returns source to a state matching the unique view.
    expect(u.value).toBe("brown\nquick\nthe");
  });
});

// ─── 7. EXTERNAL: external writes refresh complements ─────────────

describe("EXTERNAL: writes to source / intermediate lens refresh downstream complements", () => {
  it("external write to source resets lowercase's mask", () => {
    const s = str("Hello World");
    const lo = s.lowercase();
    lo.peek();
    expect(lo.value).toBe("hello world");
    s.value = "ALL CAPS HERE";
    expect(lo.value).toBe("all caps here");
    lo.value = "all caps here";
    expect(s.value).toBe("ALL CAPS HERE");
  });

  it("external write through trim refreshes lowercase downstream", () => {
    const s = str("  Hello World  ");
    const t = s.trim();
    const lo = t.lowercase();
    t.peek();
    lo.peek();
    t.value = "ALL CAPS"; // external relative to lo
    expect(lo.value).toBe("all caps");
    lo.value = "hi bye";
    expect(s.value).toBe("  HI BYE  ");
  });
});

// ─── 8. NICHE: things the user might do that should be benign ─────

describe("NICHE: corner cases that shouldn't break invariants", () => {
  it("empty writes are safe", () => {
    const s = str("Hello World");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "";
    expect(s.value).toBe("");
    lo.value = "hi";
    expect(s.value).toBe("Hi");
  });

  it("repeated identity writes (1000×) don't drift", () => {
    const s = str("Hello World");
    const lo = s.lowercase();
    lo.peek();
    const v = lo.value;
    for (let i = 0; i < 1000; i++) lo.value = v;
    expect(s.value).toBe("Hello World");
  });

  it("effects fire correctly through chained lens edits", () => {
    const s = str("Hello World");
    const lo = s.lowercase();
    lo.peek();
    let last = lo.value;
    let fires = 0;
    const dispose = effect(() => {
      last = lo.value;
      fires++;
    });
    fires = 0;
    lo.value = "hi bye";
    expect(last).toBe("hi bye");
    expect(fires).toBe(1);
    s.value = "FOO BAR";
    expect(last).toBe("foo bar");
    expect(fires).toBe(2);
    dispose();
  });

  it("split + add + rejoin via lowercase: case patterns preserved per word", () => {
    const s = str("The Quick Brown Fox");
    const lo = s.lowercase();
    lo.peek();
    // Insert a new word "lazy" in the middle.
    lo.value = "the quick brown lazy fox";
    expect(s.value).toBe("The Quick Brown Lazy Fox");
    // Then remove it.
    lo.value = "the quick brown fox";
    expect(s.value).toBe("The Quick Brown Fox");
  });

  it("rename two different words in a row", () => {
    const s = str("The Quick Brown Fox");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "the slow brown fox";
    expect(s.value).toBe("The Slow Brown Fox");
    lo.value = "the slow purple fox";
    expect(s.value).toBe("The Slow Purple Fox");
  });

  it("reorder words via lowercase preserves each word's case at its NEW position", () => {
    // Source: "Hello World". User reorders to "world hello" via
    // lowercase view. Both source words were title case, so both
    // outputs should be title case regardless of which order they're
    // typed.
    const s = str("Hello World");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "world hello";
    expect(s.value).toBe("World Hello");
  });

  it("mixed-case source: 'ALL caps' word swap preserves per-word case", () => {
    const s = str("ALL caps");
    const lo = s.lowercase();
    lo.peek();
    expect(lo.value).toBe("all caps");
    // Identity write.
    lo.value = "all caps";
    expect(s.value).toBe("ALL caps");
    // Rename first word.
    lo.value = "big caps";
    expect(s.value).toBe("BIG caps");
    // Rename second word.
    lo.value = "big text";
    expect(s.value).toBe("BIG text");
  });

  it("reorder via lowercase preserves each word's case BY CONTENT", () => {
    // Source mixes title and lowercase. After reordering, each word
    // recovers its original mask via content lookup.
    const s = str("Hello world");
    const lo = s.lowercase();
    lo.peek();
    lo.value = "world hello";
    expect(s.value).toBe("world Hello");
  });

  it("duplicates: 'Hello hello' round-trips correctly", () => {
    const s = str("Hello hello");
    const lo = s.lowercase();
    lo.peek();
    expect(lo.value).toBe("hello hello");
    lo.value = "hello hello";
    expect(s.value).toBe("Hello hello");
    // FIFO consumption: first "hello" gets first mask, second gets second.
    lo.value = "world world";
    expect(s.value).toBe("World world");
  });
});

// ─── 9. Aggressive probe: long random sequences should stay safe ──

describe("AGGRESSIVE: random sequences don't corrupt or diverge", () => {
  it("100 random structural edits via lowercase converge to last-typed text (case-mapped)", () => {
    const s = str("The Quick Brown Fox");
    const lo = s.lowercase();
    lo.peek();
    // Some structural perturbations + a final canonical write. Source
    // should match what the final canonical write produces with the
    // ORIGINAL mask applied.
    const perturbations = [
      "the q uick brown fox",
      "the quick br own fox",
      "the quick brown fo x",
      "the new quick brown fox",
      "the brown fox quick",
      "",
      "the",
      "the quick",
      "the quick brown fox",
    ];
    for (const v of perturbations) lo.value = v;
    expect(s.value).toBe("The Quick Brown Fox");
  });

  it("write read write read … (50 cycles) stays consistent", () => {
    const s = str("Hello World");
    const lo = s.lowercase();
    lo.peek();
    for (let i = 0; i < 50; i++) {
      lo.value = "hi bye";
      expect(lo.value).toBe("hi bye");
      lo.value = "hello world";
      expect(lo.value).toBe("hello world");
      expect(s.value).toBe("Hello World");
    }
  });

  it("split / rejoin under EVERY split point in 'Quick' is reversible", () => {
    const original = "The Quick Brown Fox";
    for (let i = 1; i < "Quick".length; i++) {
      const s = str(original);
      const lo = s.lowercase();
      lo.peek();
      const split = `the qu${"ick".slice(0, i)} ${"ick".slice(i)} brown fox`.replace(
        /qu(\S+)/,
        (_, rest) => `qu${rest}`,
      );
      // Simpler: insert a space at position 4 + i in lowercase view.
      const lower = "the quick brown fox";
      const splitView = `${lower.slice(0, 4 + i)} ${lower.slice(4 + i)}`;
      lo.value = splitView;
      lo.value = lower; // rejoin
      expect(s.value).toBe(original);
      void split;
    }
  });

  it("insert N new words and remove them: source returns to original", () => {
    const s = str("Hello World");
    const lo = s.lowercase();
    lo.peek();
    for (let i = 1; i <= 5; i++) {
      const extras = Array.from({ length: i }, (_, k) => `new${k}`).join(" ");
      lo.value = `hello ${extras} world`;
      lo.value = "hello world";
      expect(s.value).toBe("Hello World");
    }
  });

  it("EVERY edit sequence ending at the same view value produces the same source", () => {
    // Determinism: two different sequences of intermediate writes
    // ending at the same final view value should produce the same
    // source.
    const finalView = "hello world";

    const sA = str("Hello World");
    const loA = sA.lowercase();
    loA.peek();
    loA.value = "foo bar";
    loA.value = "x y z w";
    loA.value = "";
    loA.value = finalView;

    const sB = str("Hello World");
    const loB = sB.lowercase();
    loB.peek();
    loB.value = "completely different";
    loB.value = "";
    loB.value = "another set";
    loB.value = finalView;

    expect(sA.value).toBe(sB.value);
  });
});

// ─── 10. trim correctness in the presence of all-whitespace / edges ───

describe("trim edge cases", () => {
  it("all-whitespace source: trim view is empty, writes append to lead", () => {
    const s = str("   ");
    const t = s.trim();
    t.peek();
    expect(t.value).toBe("");
    t.value = "hi";
    expect(s.value).toBe("   hi");
    // Now lead='   ', trail=''. Re-read trim:
    expect(t.value).toBe("hi");
    // Writing back is a no-op.
    t.value = "hi";
    expect(s.value).toBe("   hi");
  });

  it("trim: padding survives repeated edits with internal whitespace changes", () => {
    const s = str("\t  hello world  \n");
    const t = s.trim();
    t.peek();
    t.value = "x y z";
    expect(s.value).toBe("\t  x y z  \n");
    t.value = "hello world"; // back to original
    expect(s.value).toBe("\t  hello world  \n");
  });

  it("trim: empty target preserves padding (collapsed source)", () => {
    const s = str("  hi  ");
    const t = s.trim();
    t.peek();
    t.value = "";
    expect(s.value).toBe("    "); // lead + "" + trail
    t.value = "back";
    expect(s.value).toBe("  back  ");
  });
});

// ─── 11. words behaviour with unusual separators ──────────────────

describe("words view with unusual separators", () => {
  it("comma-separated source: edits keep commas where they were", () => {
    const s = str("a,b,c");
    const w = s.words();
    w.peek();
    expect(w.value).toBe("a\nb\nc");
    w.value = "x\ny\nz";
    expect(s.value).toBe("x,y,z");
  });

  it("mixed separators: 'a, b; c.': replacing values preserves each sep", () => {
    const s = str("a, b; c.");
    const w = s.words();
    w.peek();
    w.value = "x\ny\nz";
    expect(s.value).toBe("x, y; z.");
  });

  it("removing trailing word keeps trailing separator", () => {
    const s = str("hello world.");
    const w = s.words();
    w.peek();
    w.value = "hi";
    expect(s.value).toBe("hi.");
  });

  it("adding a word past the end uses fallback ' '", () => {
    const s = str("hello world");
    const w = s.words();
    w.peek();
    w.value = "hello\nworld\nfox";
    expect(s.value).toBe("hello world fox");
  });
});
