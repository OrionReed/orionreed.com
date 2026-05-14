import { signal, computed, effect } from "@minim/signals";
import { Vec, vec, Box, Color, rgb, Matrix2D, Num, num } from "@minim/values";
import { bench, group } from "mitata";
import { memory } from "./memory";

group("construction (cost per instance)", () => {
  bench("raw signal({x,y})", () => signal({ x: 0, y: 0 })).baseline(true);
  bench("Vec.signal({x,y})", () => Vec.signal({ x: 0, y: 0 }));
  bench("vec(0, 0)", () => vec(0, 0));
  bench("Vec.derived(thunk)", () => {
    const a = signal({ x: 0, y: 0 });
    return Vec.derived(() => a.value);
  });
  bench("Vec.lens(read,write)", () => {
    const a = signal({ x: 0, y: 0 });
    return Vec.lens(
      () => a.value,
      (v) => {
        a.value = v;
      },
    );
  });
  bench("Box.signal({x,y,w,h})", () => Box.signal({ x: 0, y: 0, w: 1, h: 1 }));
  bench("Color.signal({r,g,b,a})", () =>
    Color.signal({ r: 0, g: 0, b: 0, a: 1 }),
  );
  bench("rgb(r,g,b)", () => rgb(0, 0, 0));
  bench("Matrix2D.signal(identity)", () =>
    Matrix2D.signal({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  );
});

// ── Num vs raw scalar signal — the perf cost of using `num(0)` for
//    every numeric cell instead of `signal(0)`.

group("Num vs raw scalar signal", () => {
  bench("raw signal(0)", () => signal(0)).baseline(true);
  bench("Num.signal(0)", () => Num.signal(0));
  bench("num(0)", () => num(0));
});

group("Num vs raw scalar — read .value (warmed)", () => {
  const r = signal(0);
  const n = num(0);
  bench("raw signal: r.value", () => r.value).baseline(true);
  bench("Num: n.value", () => n.value);
});

group("Num vs raw scalar — write .value (no subscribers)", () => {
  const r = signal(0);
  const n = num(0);
  let i = 0;
  bench("raw signal: r.value = ++i", () => {
    r.value = ++i;
  }).baseline(true);
  bench("Num: n.value = ++i", () => {
    n.value = ++i;
  });
});

group("Num vs raw scalar — write with 1 subscriber", () => {
  const r = signal(0);
  const n = num(0);
  let observed = 0;
  const e1 = effect(() => { observed += r.value; });
  const e2 = effect(() => { observed += n.value; });
  let i = 0;
  bench("raw signal: r.value = ++i", () => {
    r.value = ++i;
  }).baseline(true);
  bench("Num: n.value = ++i", () => {
    n.value = ++i;
  });
  void e1; void e2; void observed;
});

// Construction cost paid AT TIME OF FIRST AXIS ACCESS — measures the
// lazy-build path (lens construction + own-property install).
group("first axis access (lazy field accessor build)", () => {
  bench("Vec.signal — touch .x first time", () => {
    const v: any = Vec.signal({ x: 0, y: 0 });
    return v.x;
  }).baseline(true);

  bench("Box.signal — touch .x first time", () => {
    const b: any = Box.signal({ x: 0, y: 0, w: 1, h: 1 });
    return b.x;
  });

  bench("Box.signal — touch .center first time (lazy getter)", () => {
    const b: any = Box.signal({ x: 0, y: 0, w: 1, h: 1 });
    return b.center;
  });

  bench("Vec.signal — touch .length first time (lazy getter)", () => {
    const v: any = Vec.signal({ x: 3, y: 4 });
    return v.length;
  });
});

// Sanity: prove computed wraps don't differ wildly.
group("computed construction (baseline)", () => {
  const sig = signal({ x: 0, y: 0 });
  bench("computed(() => sig.value)", () => computed(() => sig.value));
});

// ── Memory (fixed-population heap-delta, printed after the benches) ─
//
// Baseline first; relative numbers show overhead-over-baseline.
memory("plain {x,y} object", (i) => ({ x: i, y: i }));
memory("signal(0) (raw scalar)", (i) => signal(i));
memory("Num.signal(0)", (i) => Num.signal(i));
memory("signal({x,y})", (i) => signal({ x: i, y: i }));
memory("Vec.signal({x,y})", (i) => Vec.signal({ x: i, y: i }));
memory("Box.signal({x,y,w,h})", (i) =>
  Box.signal({ x: i, y: i, w: 1, h: 1 }),
);
memory("Color.signal({r,g,b,a})", (i) =>
  Color.signal({ r: i / 255, g: i / 255, b: i / 255, a: 1 }),
);
memory("Matrix2D.signal(identity)", (i) =>
  Matrix2D.signal({ a: 1, b: 0, c: 0, d: 1, e: 0, f: i }),
);
