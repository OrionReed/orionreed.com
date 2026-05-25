// codecs.ts — bidirectional codec lenses between `Signal<string>` and
// typed value classes. The shape that lets you bind a writable text
// (form input, URL param, label) to a typed signal in one line.
//
// Each codec is a 1-input cross-class lens on top of `Cls.lens` —
// no new value classes. Strings stay as bare `Signal<string>`; the
// typed end is `Num` / `Color` / etc. Writes round-trip through the
// codec and update the source.
//
// Naming convention:
//
//   `<typed>FromText(text, opts?)` — text is the source of truth; the
//                                    typed view parses on read,
//                                    formats and writes back.
//   `textFrom<Typed>(typed, opts?)` — typed value is the source; the
//                                    text view formats on read, parses
//                                    and writes back.
//
// Either direction, both auto-fuse with the rest of the lens graph.
// Pick based on which side stores authoritative state.

import { lens, type Read, type Signal, type Writable } from "../signal";
import { Color } from "./color";
import { Num } from "./num";

// ─── Num ↔ Text ─────────────────────────────────────────────────────

export interface NumCodecOpts {
  /** Decimals for the formatted text. Default: stringify as-is
   *  (`String(v)`), preserving the JS default representation. */
  decimals?: number;
  /** Read fallback when text doesn't parse to a finite number.
   *  Default: `NaN`. Typical override: `0`, or the prior value. */
  fallback?: number;
}

const formatN = (v: number, decimals?: number) =>
  decimals !== undefined ? v.toFixed(decimals) : String(v);

const parseN = (s: string, fallback: number) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : fallback;
};

/** Parse a writable `Signal<string>` into a writable `Num`. Reads
 *  call `parseFloat`; writes call `String(...)` (or `toFixed`) and
 *  set the source text. NaN/empty input reads fall back to
 *  `opts.fallback ?? NaN`. */
export function numFromText(text: Read<string>, opts: NumCodecOpts = {}): Writable<Num> {
  const fallback = opts.fallback ?? Number.NaN;
  const decimals = opts.decimals;
  return Num.lens(
    text,
    s => parseN(s, fallback),
    n => formatN(n, decimals),
  );
}

/** Format a writable `Num` as a writable text view. Reads stringify;
 *  writes `parseFloat` and set the underlying num. */
export function textFromNum(n: Read<number>, opts: NumCodecOpts = {}): Writable<Signal<string>> {
  const fallback = opts.fallback ?? Number.NaN;
  const decimals = opts.decimals;
  return lens(
    n,
    v => formatN(v, decimals),
    s => parseN(s, fallback),
  );
}

// ─── Num (seconds) ↔ HH:MM:SS Text ──────────────────────────────────

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

const formatTime = (totalSec: number): string => {
  if (!Number.isFinite(totalSec) || totalSec < 0) return "00:00";
  const s = Math.floor(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
};

const parseTime = (s: string, fallback: number): number => {
  const parts = s.split(":").map(p => parseFloat(p));
  if (parts.some(p => !Number.isFinite(p))) return fallback;
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return fallback;
};

/** Parse a `HH:MM:SS` (or `MM:SS`) text into a writable seconds-Num.
 *  Auto-detects which separator form was written; writes format with
 *  hours iff the value is `>= 3600s`. */
export function secondsFromText(
  text: Read<string>,
  opts: { fallback?: number } = {},
): Writable<Num> {
  const fallback = opts.fallback ?? 0;
  return Num.lens(
    text,
    s => parseTime(s, fallback),
    n => formatTime(n),
  );
}

/** Format a writable seconds-Num as a `HH:MM:SS` / `MM:SS` text view. */
export function textFromSeconds(secs: Read<number>): Writable<Signal<string>> {
  return lens(
    secs,
    v => formatTime(v),
    s => parseTime(s, 0),
  );
}

// ─── Color ↔ Hex Text ───────────────────────────────────────────────

const HEX = "0123456789abcdef";
const toHexByte = (v: number) => {
  const x = Math.max(0, Math.min(255, Math.round(v * 255)));
  return HEX[x >> 4]! + HEX[x & 0xf]!;
};

const formatHex = (c: { r: number; g: number; b: number; a: number }): string => {
  const base = `#${toHexByte(c.r)}${toHexByte(c.g)}${toHexByte(c.b)}`;
  return c.a >= 1 ? base : `${base}${toHexByte(c.a)}`;
};

const parseHexByte = (h: string): number => {
  const v = parseInt(h, 16);
  return Number.isNaN(v) ? 0 : v / 255;
};

/** Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. Returns the prior
 *  color on parse failure (lossy preservation). */
const parseHexColor = (
  s: string,
  prior: { r: number; g: number; b: number; a: number },
): { r: number; g: number; b: number; a: number } => {
  let h = s.trim().toLowerCase();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3 || h.length === 4) {
    h = h
      .split("")
      .map(c => c + c)
      .join("");
  }
  if (h.length !== 6 && h.length !== 8) return prior;
  const r = parseHexByte(h.slice(0, 2));
  const g = parseHexByte(h.slice(2, 4));
  const b = parseHexByte(h.slice(4, 6));
  const a = h.length === 8 ? parseHexByte(h.slice(6, 8)) : 1;
  return { r, g, b, a };
};

/** Parse a writable hex-string into a writable `Color`. Reads decode
 *  `#rrggbb[aa]`; writes encode the color and set the text. Invalid
 *  hex reads fall through to a "use prior color" inverse — the source
 *  string keeps whatever the user typed, but the color holds steady. */
export function colorFromHex(text: Read<string>): Writable<Color> {
  return Color.lens(
    text,
    s => parseHexColor(s, { r: 0, g: 0, b: 0, a: 1 }),
    c => formatHex(c),
  );
}

/** Format a writable `Color` as a hex-text view. Reads format
 *  `#rrggbb[aa]`; writes parse and set the color. Alpha-channel
 *  bytes appear iff `a < 1`. */
export function hexFromColor(c: Read<{ r: number; g: number; b: number; a: number }>) {
  return lens(
    c,
    v => formatHex(v),
    s => parseHexColor(s, { r: 0, g: 0, b: 0, a: 1 }),
  );
}
