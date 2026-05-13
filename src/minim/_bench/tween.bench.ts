import { signal } from "../core/signal";
import { Vec } from "../values/vec";
import { Color } from "../values/color";
import { lerpable } from "../core/tween";
import { bench, group } from "mitata";

const stringLerp = (a: string, b: string, t: number): string => {
  if (t <= 0.5) return a.slice(0, Math.round(a.length * (1 - t * 2)));
  return b.slice(0, Math.round(b.length * (t - 0.5) * 2));
};

// One full 60-frame tween. Per-iter cost = construct + 60 frames.
group("tween throughput (60-frame .to, no subscribers)", () => {
  bench("number: signal(0).to(100, 1)", () => {
    const s: any = signal(0);
    const t = s.to(100, 1);
    for (let f = 0; f < 60; f++) t.next(1 / 60);
  }).baseline(true);
  bench("Vec: v.to({x:100,y:50}, 1)", () => {
    const v = Vec.signal({ x: 0, y: 0 });
    const t = v.to({ x: 100, y: 50 }, 1);
    for (let f = 0; f < 60; f++) t.next(1 / 60);
  });
  bench("Color: c.to(target, 1)", () => {
    const c = Color.signal({ r: 0, g: 0, b: 0, a: 1 });
    const t = c.to({ r: 1, g: 0.5, b: 0.2, a: 1 }, 1);
    for (let f = 0; f < 60; f++) t.next(1 / 60);
  });
  bench("string (lerpable): txt.to(target, 1)", () => {
    const s: any = lerpable("hello world", stringLerp);
    const t = s.to("goodbye!", 1);
    for (let f = 0; f < 60; f++) t.next(1 / 60);
  });
});

// Per-frame cost only — construct once outside the loop.
group("tween per-frame step (signal.value = lerp(...))", () => {
  // Hand-loop: just to see what raw "write per frame" looks like.
  bench("number per-frame: hand-written", () => {
    const s: any = signal(0);
    const start = 0;
    const target = 100;
    for (let f = 0; f < 60; f++) {
      s.value = start + (target - start) * (f / 60);
    }
  }).baseline(true);

  bench("Vec per-frame: hand-written whole-value write", () => {
    const v = Vec.signal({ x: 0, y: 0 });
    const start = { x: 0, y: 0 };
    const target = { x: 100, y: 50 };
    for (let f = 0; f < 60; f++) {
      const t = f / 60;
      v.value = {
        x: start.x + (target.x - start.x) * t,
        y: start.y + (target.y - start.y) * t,
      };
    }
  });
});

// 100 simultaneous tweens, common pattern when many shapes animate.
group("100 parallel tweens (60 frames)", () => {
  bench("100 number tweens", () => {
    const sigs = Array.from({ length: 100 }, () => signal(0));
    const tweens = sigs.map((s: any) => s.to(100, 1));
    for (let f = 0; f < 60; f++) {
      const dt = 1 / 60;
      for (const t of tweens) t.next(dt);
    }
  }).baseline(true);
  bench("100 Vec tweens", () => {
    const sigs = Array.from({ length: 100 }, () => Vec.signal({ x: 0, y: 0 }));
    const tweens = sigs.map((v) => v.to({ x: 100, y: 50 }, 1));
    for (let f = 0; f < 60; f++) {
      const dt = 1 / 60;
      for (const t of tweens) t.next(dt);
    }
  });
});
