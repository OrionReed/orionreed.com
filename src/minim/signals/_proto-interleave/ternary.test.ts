// Tests for ternary / variant signals — checking that the three-state
// model actually composes nicely, and figuring out whether this is
// pulling weight vs Signal<T | undefined>.

import { describe, expect, it } from "vitest";
import { computed, effect, signal } from "../signal";
import { collapse, present, Ternary, Variant } from "./ternary";

describe("Ternary<T>", () => {
  it("three states are reactively distinguishable", () => {
    const t = Ternary.off<number>();
    const log: string[] = [];
    effect(() => {
      const s = t.value;
      log.push(s.tag);
    });
    t.empty();
    t.set(5);
    t.set(6);
    t.off();
    expect(log).toEqual(["off", "empty", "value", "value", "off"]);
  });

  it("predicates expose state as signals", () => {
    const t = Ternary.off<number>();
    expect(t.isOff.value).toBe(true);
    expect(t.isEmpty.value).toBe(false);
    expect(t.hasValue.value).toBe(false);

    t.empty();
    expect(t.isOff.value).toBe(false);
    expect(t.isEmpty.value).toBe(true);
    expect(t.isActive.value).toBe(true);

    t.set(42);
    expect(t.hasValue.value).toBe(true);
    expect(t.valueOr(0).value).toBe(42);

    t.off();
    expect(t.valueOr(0).value).toBe(0);
  });

  it("map preserves state through value-case only", () => {
    const t = Ternary.empty<number>();
    const doubled = t.map(n => n * 2);
    expect(doubled.value.tag).toBe("empty");
    t.set(3);
    expect(doubled.value).toEqual({ tag: "value", value: 6 });
    t.off();
    expect(doubled.value.tag).toBe("off");
  });
});

describe("Variant<Cases>", () => {
  it("typed match returns a signal of mapped values", () => {
    type Loading = { idle: void; loading: number; done: string; error: Error };
    const v = new Variant<Loading>({ tag: "idle", value: undefined });

    const display = v.match({
      idle: () => "idle",
      loading: n => `loading… ${n}%`,
      done: s => `done: ${s}`,
      error: e => `error: ${e.message}`,
    });

    expect(display.value).toBe("idle");
    v.set("loading", 50);
    expect(display.value).toBe("loading… 50%");
    v.set("done", "ok");
    expect(display.value).toBe("done: ok");
    v.set("error", new Error("oops"));
    expect(display.value).toBe("error: oops");
  });

  it("per-case predicates compose into bigger reactive expressions", () => {
    type Conn = { off: void; connecting: void; on: number };
    const v = new Variant<Conn>({ tag: "off", value: undefined });

    const showSpinner = computed(
      () => v.is("connecting").value || (v.value.tag === "on" && v.value.value < 0),
    );

    expect(showSpinner.value).toBe(false);
    v.set("connecting", undefined);
    expect(showSpinner.value).toBe(true);
    v.set("on", 5);
    expect(showSpinner.value).toBe(false);
    v.set("on", -1);
    expect(showSpinner.value).toBe(true);
  });
});

describe("PresenceLens (no new value class)", () => {
  it("Present<T> = (Signal<T>, Signal<boolean>) — composable, no new class", () => {
    const v = signal(10);
    const on = signal(false);
    const p = present(v, on);
    const collapsed = collapse(p);

    expect(collapsed.value).toBeNull();
    on.value = true;
    expect(collapsed.value).toBe(10);
    v.value = 42;
    expect(collapsed.value).toBe(42);
    on.value = false;
    expect(collapsed.value).toBeNull();
  });
});

// ── Finding: when does Ternary pull its weight? ─────────────────
//
// Conclusion across the three variants:
//
// • For "active w/ optional value" — `Signal<T | undefined>` works
//   but conflates "active-no-value" with "inactive." Variant<{off,
//   empty, value}> is genuinely clearer.
//
// • For drag state ("idle", "drag-start no movement yet", "drag-with-
//   point"), Ternary's three-state model matches the domain exactly.
//   You don't have to invent a sentinel.
//
// • For "loading/done/error" — Variant<Cases> is just better than
//   a discriminated union you have to spell out manually. The
//   .match() returns a signal, no manual subscription needed.
//
// PresenceLens via two signals is also fine for simple cases — and
// avoids a new value class. Pick based on whether you want explicit
// state-as-a-value or implicit-via-predicate.
