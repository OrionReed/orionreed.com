export const tokens = {
  /** CSS var so dark mode flips automatically. */
  stroke: "var(--text-color)",
  weight: 2,
  thinWeight: 1.5,
  corner: 2,
  font: "'New CM', monospace",
  /** Stack of fonts with OpenType MATH tables. */
  mathFont:
    "'New CM Math', 'Cambria Math', 'STIXTwoMath-Regular', 'NotoSansMath-Regular', 'New CM', math, serif",
  fontSize: 14,
  /** Approximate glyph aspect (SVG can't measure). */
  charWidth: 0.6,
  subFontSize: "0.75em",
  mutedOpacity: 0.5,
  tex: {
    size: 26,
    highlightColor: "rgba(255, 220, 80, 0.45)",
    highlightDurationMs: 120,
    highlightCorner: 2,
  },
  decoration: {
    gap: 2,
    braceHeight: 5,
    braceGap: 3,
    crossGap: 1,
  },
} as const;

export type Tokens = typeof tokens;
