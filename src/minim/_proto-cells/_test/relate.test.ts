// relate.test.ts — re-orientable bidirectional relation primitive.

import { describe, expect, it } from "vitest";
import { effect, num, relate, vec } from "../index";

describe("relate(a, b, fwd, bwd) — bidirectional binding", () => {
  it("Iso: writes from either side propagate", () => {
    const a = num(0);
    const b = num(0);
    relate(
      a,
      b,
      x => x + 100,
      y => y - 100,
    );
    expect(a.value).toBe(0);
    expect(b.value).toBe(100);

    a.value = 5;
    expect(a.value).toBe(5);
    expect(b.value).toBe(105);

    b.value = 200;
    expect(b.value).toBe(200);
    expect(a.value).toBe(100);
  });

  it("non-Iso lossy: writes still terminate via === equality", () => {
    const a = num(0);
    const b = num(0);
    relate(
      a,
      b,
      x => Math.round(x / 5) * 5,
      y => y,
    );
    a.value = 17;
    expect(b.value).toBe(15);
    expect(a.value).toBe(15);
  });

  it("multiple relations on the same cell: fan-out", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate(
      a,
      b,
      x => x + 10,
      y => y - 10,
    );
    relate(
      a,
      c,
      x => x * 2,
      y => y / 2,
    );
    a.value = 5;
    expect(b.value).toBe(15);
    expect(c.value).toBe(10);

    b.value = 30;
    expect(a.value).toBe(20);
    expect(c.value).toBe(40);
  });

  it("dispose: tears down the relation cleanly", () => {
    const a = num(0);
    const b = num(0);
    const r = relate(
      a,
      b,
      x => x * 2,
      y => y / 2,
    );
    a.value = 3;
    expect(b.value).toBe(6);
    r.dispose();
    a.value = 10;
    expect(b.value).toBe(6);
    b.value = 99;
    expect(a.value).toBe(10);
  });

  it("does not double-fire downstream effects", () => {
    const a = num(0);
    const b = num(0);
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );
    let fires = 0;
    effect(() => {
      void b.value;
      fires++;
    });
    fires = 0;
    a.value = 10;
    expect(b.value).toBe(11);
    expect(fires).toBe(1);
  });

  it("interacts cleanly with lens chains on either side", () => {
    const v = vec(0, 0);
    const a = num(0);
    relate(
      a,
      v.x,
      x => x,
      vx => vx,
    );
    a.value = 7;
    expect(v.value.x).toBe(7);
    v.x.value = 42;
    expect(a.value).toBe(42);
  });
});
