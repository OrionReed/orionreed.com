// Shared visual tokens. One source of truth for stroke/font/spacing
// values used across shapes, labels, and text rendering. Theme-able
// later by swapping or wrapping.

export const tokens = {
  /** Default stroke color (CSS var so dark-mode flips automatically). */
  stroke: "var(--text-color)",
  /** Standard stroke weight (px, kept constant via vector-effect). */
  weight: 2,
  /** Thin stroke weight, for ticks and crosshairs. */
  thinWeight: 1.5,
  /** Default rect corner radius. */
  corner: 2,
  /** Body label font. */
  font: "'New CM', monospace",
  /** Default label font size. */
  fontSize: 14,
  /** Approximate glyph aspect for label width estimation (SVG can't measure). */
  charWidth: 0.6,
  /** Sub/sup font size relative to parent. */
  subFontSize: "0.75em",
} as const;

export type Tokens = typeof tokens;
