// Ink color system. Three exports — `ink(hue)`, `grey`, `stroke` —
// share a single spread anchor (m=1) and differ in their mark anchor
// (m=0). `.mod(m)` interpolates between mark and spread in OKLCH.
// Anchor L values live in color.css; see `deriveAnchors` below for
// the APCA inversion that produced them.

export const HUE = {
  red: 25,
  vermillion: 30,
  orange: 50,
  ochre: 70,
  yellow: 90,
  olive: 110,
  green: 145,
  teal: 180,
  cyan: 200,
  blue: 245,
  indigo: 270,
  purple: 300,
  plum: 330,
  rose: 10,
} as const;

export type HueName = keyof typeof HUE;

const resolveHue = (h: number | HueName): number =>
  typeof h === "number" ? h : HUE[h];

export interface Ink {
  readonly H: number;
  readonly L: string;
  readonly C: string;
  /** Repeated calls replace; they don't compound. */
  mod(m: number): Ink;
  toString(): string;
}

// L and C are CSS expressions referencing --ink-* vars, so dark-mode
// flips propagate without re-rendering.
function makeInk(
  baseL: string,
  baseC: string,
  H: number,
  fillL: string,
  fillC: string,
  m: number = 0,
): Ink {
  const L =
    m === 0 ? baseL : `calc((1 - ${m}) * ${baseL} + ${m} * ${fillL})`;
  const C =
    m === 0 ? baseC : `calc((1 - ${m}) * ${baseC} + ${m} * ${fillC})`;
  return {
    L,
    C,
    H,
    mod: (newM) => makeInk(baseL, baseC, H, fillL, fillC, newM),
    toString: () => `oklch(${L} ${C} ${H})`,
  };
}

export function ink(hue: number | HueName): Ink {
  return makeInk(
    "var(--ink-l)",
    "var(--ink-c)",
    resolveHue(hue),
    "var(--ink-fill-l)",
    "var(--ink-fill-c)",
  );
}

export function inkRing(
  n: number,
  startHue: number | HueName = "red",
): Ink[] {
  const start = resolveHue(startHue);
  return Array.from({ length: n }, (_, i) => ink(start + (360 / n) * i));
}

/** Achromatic equivalent of `ink(hue)` — same anchors, no chroma. */
export const grey: Ink = makeInk(
  "var(--ink-l)",
  "0",
  0,
  "var(--ink-fill-l)",
  "0",
);

/** Max-contrast structural ink. For axis lines, labels, scaffolding. */
export const stroke: Ink = makeInk(
  "var(--stroke-l)",
  "0",
  0,
  "var(--ink-fill-l)",
  "0",
);

/**
 * APCA-inverse: OKLCH-L for a given bg-L and target Lc. Not called at
 * runtime — kept here as the documented derivation of the L numbers in
 * color.css. Run in a console to re-tune.
 *
 *   bg lighter than fg: Lc = 114·(Y_bg^0.56 − Y_fg^0.57)
 *   bg darker  than fg: Lc = 114·(Y_fg^0.62 − Y_bg^0.65)
 *   For greys, Y ≈ (L/100)³.
 */
export function deriveAnchors(bgL: number, lcTarget: number): number {
  const yBg = Math.pow(bgL / 100, 3);
  const yBgC = yBg < 0.022 ? Math.pow(0.022 - yBg, 1.414) + yBg : yBg;
  const lc = lcTarget / 114;
  const yFg =
    bgL > 50
      ? Math.pow(Math.pow(yBgC, 0.56) - lc, 1 / 0.57)
      : Math.pow(Math.pow(yBgC, 0.65) + lc, 1 / 0.62);
  return Math.pow(yFg, 1 / 3) * 100;
}
