// footgun-realuser.test.ts — adversarial probes patterned on real
// user code (drawn from `src/minim/shapes/handle.ts` and the
// scoped-propagators blog post). The goal is to model what a naive
// user — who hasn't read the engine internals — would write, and
// verify each pattern works correctly under the new design.

import { describe, expect, it } from "vitest";
import { batch, computed, effect, Num, num, Signal, signal, Vec, vec } from "../index";
import { relate } from "../relate";

describe("real-user pattern: live unit conversion (Celsius ↔ Fahrenheit)", () => {
  it("relate(C, F, c→f, f→c): edit either, the other follows", () => {
    const celsius = num(0);
    const fahrenheit = num(0);
    relate(
      celsius,
      fahrenheit,
      c => (c * 9) / 5 + 32,
      f => ((f - 32) * 5) / 9,
    );
    expect(fahrenheit.value).toBe(32); // 0 °C ≡ 32 °F

    celsius.value = 100;
    expect(fahrenheit.value).toBe(212);

    fahrenheit.value = 0;
    expect(celsius.value).toBeCloseTo(-17.778, 3);
  });

  it("with effects watching both: each updates exactly once per change", () => {
    const c = num(0);
    const f = num(0);
    relate(
      c,
      f,
      x => (x * 9) / 5 + 32,
      y => ((y - 32) * 5) / 9,
    );
    let cFires = 0,
      fFires = 0;
    const stops = [
      effect(() => {
        void c.value;
        cFires++;
      }),
      effect(() => {
        void f.value;
        fFires++;
      }),
    ];
    cFires = fFires = 0;

    c.value = 25;
    expect(cFires).toBe(1);
    expect(fFires).toBe(1);
    for (const s of stops) s();
  });
});

describe("real-user pattern: shape with custom Vec.lens (handle.scale)", () => {
  it("scale handle: position derived from center + radius * scale.x", () => {
    // Mirrors handle.scale from src/minim/shapes/handle.ts: a Vec
    // lens computed from center & scale, with a custom inverse that
    // updates only the scale.x.
    const center = vec(100, 100);
    const scale = vec(1, 1);
    const radius = 40;

    const knobPos = Vec.lens(
      () => {
        const c = center.value;
        const s = scale.value;
        return { x: c.x + radius * s.x, y: c.y };
      },
      target => {
        const c = center.value;
        const k = Math.max(0.05, Math.abs(target.x - c.x) / radius);
        scale.value = { x: k, y: k };
      },
    );

    expect(knobPos.value).toEqual({ x: 140, y: 100 });

    // Drag knob to x=180: scale should become 2 (radius=40 → (180-100)/40=2).
    knobPos.value = { x: 180, y: 100 };
    expect(scale.value).toEqual({ x: 2, y: 2 });

    // Forward updates when scale changes externally.
    scale.value = { x: 0.5, y: 0.5 };
    expect(knobPos.value).toEqual({ x: 120, y: 100 });
  });
});

describe("real-user pattern: midpoint handle with both endpoints writable", () => {
  it("midpoint handle: drag updates both endpoints by half-delta each", () => {
    const a = vec(0, 0);
    const b = vec(100, 100);

    // Midpoint mean lens: read=avg, write=both move by full delta.
    const mid = Signal.install(
      Vec,
      () => ({
        x: (a.value.x + b.value.x) / 2,
        y: (a.value.y + b.value.y) / 2,
      }),
      target => {
        const cur = {
          x: (a.peek().x + b.peek().x) / 2,
          y: (a.peek().y + b.peek().y) / 2,
        };
        const dx = target.x - cur.x;
        const dy = target.y - cur.y;
        batch(() => {
          a.value = { x: a.peek().x + dx, y: a.peek().y + dy };
          b.value = { x: b.peek().x + dx, y: b.peek().y + dy };
        });
      },
    );

    expect(mid.value).toEqual({ x: 50, y: 50 });

    mid.value = { x: 100, y: 100 };
    expect(a.value).toEqual({ x: 50, y: 50 });
    expect(b.value).toEqual({ x: 150, y: 150 });
  });
});

describe("real-user pattern: drag-clamp + rotation chain", () => {
  it("position clamped to a region, then rotation applied: writes round-trip", () => {
    // Mirrors a draggable handle constrained to a region (drag.test).
    const x = num(50);
    const y = num(50);

    const clampedX = x.clamp(0, 100);
    const clampedY = y.clamp(0, 100);

    expect(clampedX.value).toBe(50);
    clampedX.value = 200; // clamps to 100
    expect(x.value).toBe(100);
    clampedX.value = -50;
    expect(x.value).toBe(0);
    clampedX.value = 75;
    expect(x.value).toBe(75);

    // y still untouched by x writes
    expect(y.value).toBe(50);
    void clampedY;
  });
});

describe("real-user pattern: tween-like animation of a fused field", () => {
  it("write tr.translate.x in a tight loop: each frame correct", () => {
    const tr = signal({ translate: { x: 0, y: 0 } });
    const x = Signal.fieldOf(
      Signal.fieldOf(
        tr,
        "translate",
        Signal as new (
          ...args: never[]
        ) => Signal<{ x: number; y: number }>,
      ),
      "x",
      Num,
    );

    const observed: number[] = [];
    const stop = effect(() => {
      observed.push(x.value);
    });
    observed.length = 0;

    // Simulate animation frames.
    for (let i = 1; i <= 60; i++) {
      (x as unknown as { value: number }).value = i;
    }
    expect(observed).toHaveLength(60);
    expect(observed[0]).toBe(1);
    expect(observed[observed.length - 1]).toBe(60);
    stop();
  });
});

describe("real-user pattern: mutation-vs-replacement footgun", () => {
  it("FOOTGUN: mutating tr.value directly does not trigger reactivity", () => {
    const tr = signal({ translate: { x: 0, y: 0 } });
    let fires = 0;
    const stop = effect(() => {
      void tr.value;
      fires++;
    });
    fires = 0;

    // User mutates the value object directly — engine never sees
    // a change because pendingValue !== currentValue check is by ===
    // and the same object reference is being compared.
    tr.value.translate.x = 99;
    expect(tr.value.translate.x).toBe(99); // mutation did happen
    expect(fires).toBe(0); // BUT no reactivity!

    // To trigger, you must write a new reference.
    tr.value = { translate: { x: 99, y: 0 } };
    expect(fires).toBe(1);
    stop();
  });

  it("FOOTGUN: vec.x (field lens) hides this footgun for nested objects", () => {
    // Field lenses spread-replace, so writes through them ALWAYS
    // create new references. Users who write `tr.translate.x.value = …`
    // sidestep the mutation footgun by construction.
    const tr = signal({ translate: { x: 0, y: 0 } });
    const x = Signal.fieldOf(
      Signal.fieldOf(
        tr,
        "translate",
        Signal as new (
          ...args: never[]
        ) => Signal<{ x: number; y: number }>,
      ),
      "x",
      Num,
    );
    let fires = 0;
    const stop = effect(() => {
      void tr.value;
      fires++;
    });
    fires = 0;
    (x as unknown as { value: number }).value = 99; // proper write
    expect(fires).toBe(1);
    expect(tr.value.translate.x).toBe(99);
    expect(tr.value.translate.y).toBe(0);
    stop();
  });
});

describe("real-user pattern: relate with non-injective fwd (visual quantization)", () => {
  it("rounded-to-step display ↔ raw value: both directions work, edges quantize", () => {
    // A common UI pattern: displayed value snaps to multiples of 5
    // for visual clarity, but underlying value can be arbitrary.
    const raw = num(0);
    const display = num(0);
    relate(
      raw,
      display,
      x => Math.round(x / 5) * 5,
      y => y, // direct write
    );

    raw.value = 13;
    expect(display.value).toBe(15); // snapped to nearest 5
    // After the relate cycle: display=15 → raw=15 (lossy).
    expect(raw.value).toBe(15);

    display.value = 22;
    // 22 → raw=22 → display=Math.round(22/5)*5=20.
    expect(raw.value).toBe(20);
    expect(display.value).toBe(20);
  });
});

describe("real-user pattern: chain of relates (a ↔ b ↔ c)", () => {
  it("write to a propagates to c via b", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );
    relate(
      b,
      c,
      x => x * 2,
      y => y / 2,
    );

    a.value = 10;
    expect(b.value).toBe(11);
    expect(c.value).toBe(22);

    c.value = 100;
    expect(b.value).toBe(50);
    expect(a.value).toBe(49);
  });

  it("write to middle propagates both ways", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );
    relate(
      b,
      c,
      x => x * 2,
      y => y / 2,
    );

    b.value = 5;
    expect(a.value).toBe(4);
    expect(c.value).toBe(10);
  });
});

describe("real-user pattern: writeBack inside an effect (event handler shape)", () => {
  it("event handler that updates a related signal without re-firing self", () => {
    // Pattern: a click handler that reads a counter and increments
    // it via `writeBack` so the click effect doesn't loop on its
    // own writes.
    const counter = num(0);
    const clickEvent = signal(0); // bumps on each click
    let observedCount = -1;

    const stop = effect(() => {
      void clickEvent.value;
      observedCount = counter.value;
      // Increment counter via writeBack to avoid self-trigger.
      (counter as unknown as { writeBack: (v: number) => void }).writeBack(observedCount + 1);
    });

    expect(counter.value).toBe(1); // initial run

    clickEvent.value = 1;
    expect(counter.value).toBe(2);

    clickEvent.value = 2;
    expect(counter.value).toBe(3);
    stop();
  });
});

describe("real-user pattern: dispose during reactive chain", () => {
  it("disposing relate inside an effect that's writing", () => {
    const a = num(0);
    const b = num(0);
    const r = relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );

    let aFires = 0;
    const stop = effect(() => {
      void a.value;
      aFires++;
      if (aFires === 2) r.dispose(); // tear down the relation mid-cascade
    });
    aFires = 0;

    a.value = 5; // triggers relate; aFires=1
    a.value = 10; // aFires=2, disposes relate
    a.value = 20; // relate is gone; b stays at whatever it was
    expect(aFires).toBe(3);
    // No assertion on b's value — disposal mid-effect is unspecified.
    // Just ensure no crash.
    stop();
  });
});
