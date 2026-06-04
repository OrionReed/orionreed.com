// Approximate equality. Relative-or-absolute so it handles both tiny
// and large floats without separate cases.

export const approx =
  (eps = 1e-9) =>
  (a: number, b: number): boolean =>
    Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
