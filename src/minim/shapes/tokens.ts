// Shared visual tokens — stroke, font, spacing defaults.

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
  mutedOpacity: 0.5,
} as const;

export type Tokens = typeof tokens;
