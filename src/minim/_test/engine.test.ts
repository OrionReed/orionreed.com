// engine.test.ts — engine semantics specific to minim's impl.
//
// RFTS (conformance.test.ts) covers the algorithm-level correctness;
// this file tests our additions:
//   - peek() honors Dirty
//   - Constructor takes plain T (binding via the `bind` free fn)
//   - bind(target, source) — the binding API
//   - isCell brand: prototype-based, not structural
//   - readNow() unwraps reactives without footgunning plain {value: …}

import { Cell, cell, derive, effect, isCell, Num, readNow } from "@minim/signals";
import { describe, it } from "vitest";
import { check, section } from "./_check";

describe("engine", () => {
  it("all checks", () => {
    section("peek() honors Dirty flag");
    {
      const s = cell(0);
      let effectVal = -1;
      const stop = effect(() => {
        effectVal = s.value;
      });
      s.value = 42;
      check("peek after write returns new value", s.peek() === 42);
      check("effect saw new value", effectVal === 42);
      stop();
    }

    section("Constructor: plain T only");
    {
      const s = new Cell(7);
      check("plain init", s.value === 7);
    }

    section("effect-driven mirror — auto-updates with disposer");
    {
      const a = cell(2);
      const s = cell(0);
      const stop = effect(() => {
        s.value = a.value * 10;
      });
      check("initial computed via effect", s.value === 20);
      a.value = 5;
      check("auto-updates on a change", s.value === 50);
      stop();
      a.value = 99;
      check("after dispose, no update", s.value === 50);
    }

    section("effect mirror with cell source");
    {
      const src = cell(100);
      const t = cell(0);
      const stop = effect(() => {
        t.value = src.value;
      });
      check("initial sync", t.value === 100);
      src.value = 200;
      check("auto-updates", t.value === 200);
      t.value = 999;
      check("manual write takes effect", t.value === 999);
      src.value = 50;
      check("next src change overwrites manual", t.value === 50);
      stop();
    }

    section("isCell brand: branded prototypes, not structural .value");
    check("isCell(cell)", isCell(cell(0)));
    check("isCell(computed)", isCell(derive(() => 0)));
    check(
      "isCell(lens)",
      isCell(
        Num.lens(
          [cell(0)] as const,
          ([n]) => n,
          () => [undefined] as const,
        ),
      ),
    );
    check("isCell(plain {value: 5})", !isCell({ value: 5 }));
    check("isCell(plain {value: 5, name: 'a'})", !isCell({ value: 5, name: "a" }));
    check("isCell(number)", !isCell(5));
    check("isCell(fn)", !isCell(() => 5));
    check("isCell(null)", !isCell(null));

    section("readNow() unwraps via brand, not structural shape");
    {
      check("readNow(5)", readNow(5) === 5);
      check("readNow(cell(15))", readNow(cell(15)) === 15);
      const plainT = { value: 5, name: "alice" };
      check("plain T with .value is preserved", readNow(plainT as any) === plainT);
    }
  });
});
