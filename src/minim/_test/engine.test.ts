// engine.test.ts — engine semantics specific to minim's impl.
//
// RFTS (conformance.test.ts) covers the algorithm-level correctness;
// this file tests our additions:
//   - peek() honors Dirty
//   - Constructor takes plain T (binding is .bind())
//   - sig.bind(source) — the binding API
//   - isSignal brand: prototype-based, not structural
//   - value() unwraps reactives without footgunning plain {value: …}

import { describe, it } from "vitest";
import { check, section } from "./_check";
import { signal, computed, effect, lens, value, isSignal, Signal } from "@minim/signals";

describe("engine", () => {
  it("all checks", () => {
    section("peek() honors Dirty flag");
    {
      const s = signal(0);
      let effectVal = -1;
      const stop = effect(() => { effectVal = s.value; });
      s.value = 42;
      check("peek after write returns new value", s.peek() === 42);
      check("effect saw new value", effectVal === 42);
      stop();
    }

    section("Constructor: plain T only");
    {
      const s = new Signal(7);
      check("plain init", s.value === 7);
    }

    section("target.bind(source) — the binding API");
    {
      const a = signal(2);
      const s = signal(0);
      const stop = s.bind(() => a.value * 10);
      check("initial computed via thunk", s.value === 20);
      a.value = 5;
      check("auto-updates on a change", s.value === 50);
      stop();
      a.value = 99;
      check("after dispose, no update", s.value === 50);
    }

    section("bind with cell source");
    {
      const src = signal(100);
      const t = signal(0);
      const stop = t.bind(src);
      check("initial sync", t.value === 100);
      src.value = 200;
      check("auto-updates", t.value === 200);
      t.value = 999;
      check("manual write takes effect", t.value === 999);
      src.value = 50;
      check("next src change overwrites manual", t.value === 50);
      stop();
    }

    section("isSignal brand: branded prototypes, not structural .value");
    {
      check("isSignal(signal)", isSignal(signal(0)));
      check("isSignal(computed)", isSignal(computed(() => 0)));
      check("isSignal(lens)", isSignal(lens(() => 0, () => {})));
      check("isSignal(plain {value: 5})", !isSignal({ value: 5 }));
      check("isSignal(plain {value: 5, name: 'a'})", !isSignal({ value: 5, name: "a" }));
      check("isSignal(number)", !isSignal(5));
      check("isSignal(fn)", !isSignal(() => 5));
      check("isSignal(null)", !isSignal(null));
    }

    section("value() unwraps via brand, not structural shape");
    {
      check("value(5)", value(5) === 5);
      check("value(() => 10)", value(() => 10) === 10);
      check("value(signal(15))", value(signal(15)) === 15);
      const plainT = { value: 5, name: "alice" };
      check("plain T with .value is preserved", value(plainT as any) === plainT);
    }
  });
});
