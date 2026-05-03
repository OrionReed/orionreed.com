// Randomness helpers — designed for namespace import:
//   import * as R from "./rand"
//   R.float(0, 1), R.shuffle(arr), R.hex(3)

/** Random float in [min, max). */
export function float(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/** Random integer in [min, max] inclusive. */
export function int(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pick a random element from a non-empty array. */
export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Fisher-Yates shuffle, returns a new array. */
export function shuffle<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Random string of `length` characters drawn from `charset`. */
export function string(length: number, charset: string): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += charset[Math.floor(Math.random() * charset.length)];
  }
  return out;
}

/** Random hex string of `length` characters (0-9, a-f). */
export function hex(length: number): string {
  return string(length, "0123456789abcdef");
}

/** Random alphanumeric string. */
export function alphanumeric(length: number): string {
  return string(
    length,
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  );
}

/** Random boolean with given probability of true (default 0.5). */
export function chance(probability = 0.5): boolean {
  return Math.random() < probability;
}
