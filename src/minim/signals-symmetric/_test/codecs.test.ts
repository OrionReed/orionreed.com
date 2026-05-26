// codecs.test.ts — bidirectional codec lenses (text ↔ typed values).

import { describe, expect, it } from "vitest";
import {
  colorFromHex,
  hexFromColor,
  numFromText,
  rgb,
  secondsFromText,
  signal,
  textFromNum,
  textFromSeconds,
} from "../index";

describe("numFromText", () => {
  it("read: parses parseFloat-compatible strings", () => {
    const t = signal("3.14");
    const n = numFromText(t);
    expect(n.value).toBe(3.14);
  });

  it("write: formats and writes back to the source text", () => {
    const t = signal("0");
    const n = numFromText(t);
    n.value = 42;
    expect(t.value).toBe("42");
  });

  it("source change reflects in num", () => {
    const t = signal("1");
    const n = numFromText(t);
    t.value = "7.5";
    expect(n.value).toBe(7.5);
  });

  it("fallback covers unparseable input", () => {
    const t = signal("abc");
    const n = numFromText(t, { fallback: -1 });
    expect(n.value).toBe(-1);
  });

  it("decimals option formats with toFixed", () => {
    const t = signal("0");
    const n = numFromText(t, { decimals: 2 });
    n.value = Math.PI;
    expect(t.value).toBe("3.14");
  });
});

describe("textFromNum", () => {
  it("read: stringifies the num", () => {
    const n = signal(3.14);
    const t = textFromNum(n);
    expect(t.value).toBe("3.14");
  });

  it("write: parses and writes back to source", () => {
    const n = signal(0);
    const t = textFromNum(n);
    t.value = "42";
    expect(n.value).toBe(42);
  });
});

describe("colorFromHex", () => {
  it("parses #rrggbb", () => {
    const t = signal("#ff8000");
    const c = colorFromHex(t);
    expect(c.value.r).toBeCloseTo(1, 2);
    expect(c.value.g).toBeCloseTo(0.5, 2);
    expect(c.value.b).toBeCloseTo(0, 2);
    expect(c.value.a).toBe(1);
  });

  it("parses #rgb shorthand", () => {
    const t = signal("#f80");
    const c = colorFromHex(t);
    expect(c.value.r).toBeCloseTo(1, 2);
    expect(c.value.g).toBeCloseTo(0xff / 255 / 2, 1); // #88 = 136/255
    expect(c.value.b).toBe(0);
  });

  it("parses #rrggbbaa with alpha", () => {
    const t = signal("#000000ff");
    const c = colorFromHex(t);
    expect(c.value.a).toBe(1);
    t.value = "#00000000";
    expect(c.value.a).toBe(0);
  });

  it("write: encodes and writes back", () => {
    const t = signal("#000000");
    const c = colorFromHex(t);
    c.value = { r: 1, g: 0, b: 0, a: 1 };
    expect(t.value).toBe("#ff0000");
  });

  it("write with non-unit alpha emits 8-byte hex", () => {
    const t = signal("#000000");
    const c = colorFromHex(t);
    c.value = { r: 0, g: 0, b: 0, a: 0.5 };
    expect(t.value).toBe("#00000080");
  });
});

describe("hexFromColor", () => {
  it("read: formats the color as hex", () => {
    const c = rgb(1, 0, 0);
    const t = hexFromColor(c);
    expect(t.value).toBe("#ff0000");
  });

  it("write: parses and updates color", () => {
    const c = rgb(0, 0, 0);
    const t = hexFromColor(c);
    t.value = "#00ff00";
    expect(c.value.g).toBeCloseTo(1, 2);
    expect(c.value.r).toBe(0);
  });
});

describe("secondsFromText / textFromSeconds", () => {
  it("formats m:ss when under one hour", () => {
    const n = signal(75);
    const t = textFromSeconds(n);
    expect(t.value).toBe("01:15");
  });

  it("formats h:mm:ss when over one hour", () => {
    const n = signal(3725); // 1h 02m 05s
    const t = textFromSeconds(n);
    expect(t.value).toBe("01:02:05");
  });

  it("parses MM:SS into seconds", () => {
    const t = signal("02:30");
    const s = secondsFromText(t);
    expect(s.value).toBe(150);
  });

  it("parses HH:MM:SS into seconds", () => {
    const t = signal("01:02:05");
    const s = secondsFromText(t);
    expect(s.value).toBe(3725);
  });

  it("write seconds → text rounds-trip", () => {
    const t = signal("00:00");
    const s = secondsFromText(t);
    s.value = 90;
    expect(t.value).toBe("01:30");
  });

  it("invalid text falls back to 0", () => {
    const t = signal("garbage");
    const s = secondsFromText(t);
    expect(s.value).toBe(0);
  });
});
