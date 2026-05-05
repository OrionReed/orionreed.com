// Shared visual tokens — single source of truth for stroke/font/spacing.

export const tokens = {
  /** Default stroke; CSS var so dark mode flips automatically. */
  stroke: "var(--text-color)",
  weight: 2,
  thinWeight: 1.5,
  corner: 2,
  font: "'New CM', monospace",
  fontSize: 14,
  /** Approximate glyph aspect for label width (SVG can't measure). */
  charWidth: 0.6,
  subFontSize: "0.75em",
} as const;

export type Tokens = typeof tokens;
