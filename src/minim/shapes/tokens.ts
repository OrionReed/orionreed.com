// Shared visual tokens — stroke, font, spacing defaults.

export const tokens = {
  /** Default stroke; CSS var so dark mode flips automatically. */
  stroke: "var(--text-color)",
  weight: 2,
  thinWeight: 1.5,
  corner: 2,
  font: "'New CM', monospace",
  /** Math-aware font stack. `New CM Math` ships an OpenType MATH table
   *  so browsers can size radicals/fractions correctly; the rest are
   *  cross-platform fallbacks that also have a MATH table. */
  mathFont:
    "'New CM Math', 'Cambria Math', 'STIXTwoMath-Regular', 'NotoSansMath-Regular', 'New CM', math, serif",
  fontSize: 14,
  /** Approximate glyph aspect for label width (SVG can't measure). */
  charWidth: 0.6,
  subFontSize: "0.75em",
  mutedOpacity: 0.5,
  /** TexShape-specific defaults (highlight visual, etc.). */
  tex: {
    /** Background tint applied while a part's `highlighted` is true. */
    highlightColor: "rgba(255, 220, 80, 0.45)",
    /** Background-color transition duration on parts (ms). */
    highlightDurationMs: 120,
    /** Corner radius applied to the part background tint. */
    highlightCorner: 2,
  },
  /** Defaults for derived decorations (`brace`, `box`, `underline`,
   *  `cross`). Per-call options always override. */
  decoration: {
    /** Pad between target bounds and the decoration. */
    gap: 2,
    /** Brace amplitude in local-frame units. */
    braceHeight: 5,
    /** Brace gap (slightly larger so the brace tips don't touch text). */
    braceGap: 3,
    /** Cross / strikethrough gap. */
    crossGap: 1,
  },
} as const;

export type Tokens = typeof tokens;
