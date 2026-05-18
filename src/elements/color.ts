// Ink system: `ink`/`grey`/`stroke` share a spread anchor (m=1); `.mod(m)` interpolates in OKLCH.

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

// L/C are CSS exprs over --ink-* vars; dark-mode flips propagate without re-render.
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

/** APCA-inverse: OKLCH-L for a given bg-L and target Lc. Re-derives anchors in color.css. */
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
