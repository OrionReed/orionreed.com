// values.test.ts — Vec / Num / Color / Box / Transform.

import { describe, it } from "vitest";
import { check, section } from "./_check";
import {
  Signal, signal, effect,
  classOf, linearOf, requireLinear, requireLerp,
  LINEAR,
  vec, Vec, num, Num, rgb, Color, box, Box, transform, Transform,
} from "@minim/signals";

describe("values", () => {
  it("all checks", () => {
    section("Vec construction + read/write");
    {
      const v = vec(3, 4);
      check("read .value", v.value.x === 3 && v.value.y === 4);
      v.value = { x: 10, y: 20 };
      check("write .value", v.value.x === 10);
      check("peek()", v.peek().x === 10);
    }

    section("Vec methods return Vec — chainable");
    {
      const v = vec(1, 2);
      const r2 = v.add({ x: 10, y: 20 }).scale(2);
      check("chained: (1+10)*2", r2.value.x === 22 && r2.value.y === 44);
      v.value = { x: 0, y: 0 };
      check("re-derives on v change", r2.value.x === 20);
    }

    section("Reactive method args (Val<T> through brand)");
    {
      const a = vec(0, 0);
      const b = vec(1, 1);
      const sum = a.add(b);
      check("initial: 0+1 = 1", sum.value.x === 1);
      b.value = { x: 5, y: 5 };
      check("re-derives on b change", sum.value.x === 5);
      a.value = { x: 10, y: 10 };
      check("re-derives on a change", sum.value.x === 15);
    }

    section("Computed as arg — also auto-subscribes");
    {
      const a = vec(0, 0);
      const seed = vec(1, 1);
      const scaled = seed.scale(10);
      const sum = a.add(scaled);
      check("initial: 0 + 10 = 10", sum.value.x === 10);
      seed.value = { x: 5, y: 5 };
      check("re-derives on seed change", sum.value.x === 50);
    }

    section("Thunk arg — auto-tracks via the lambda");
    {
      const a = vec(0, 0);
      const k = signal(2);
      const result = a.scale(() => k.value * 10);
      a.value = { x: 1, y: 1 };
      check("initial: 1 × 20", result.value.x === 20);
      k.value = 5;
      check("k change: 1 × 50", result.value.x === 50);
    }

    section("Field access: v.x is a typed Num lens");
    {
      const v = vec(3, 4);
      check("v.x reads", v.x.value === 3);
      v.x.value = 99;
      check("v.x writes propagate to v", v.value.x === 99);
      check("v.x identity stable", v.x === v.x);
      check("v.y !== v.x", v.y !== v.x);
      check("v.x.add(1) reactive", v.x.add(1).value === 100);
    }

    section("Per-field subscription correctness");
    {
      const v = vec(0, 0);
      let xfires = 0, yfires = 0;
      const sx = effect(() => { void v.x.value; xfires++; });
      const sy = effect(() => { void v.y.value; yfires++; });
      v.value = { x: 5, y: 0 };
      check("x change: x fires, y doesn't", xfires === 2 && yfires === 1);
      v.value = { x: 5, y: 7 };
      check("y change: y fires, x doesn't", xfires === 2 && yfires === 2);
      sx(); sy();
    }

    section("derive(c => c.foo().bar()) — single Computed");
    {
      const v = vec(0, 0);
      let fires = 0;
      const r = v.derive(c => c.add({ x: 1, y: 1 }).scale(2).add({ x: 0, y: 0 }).scale(1));
      const stop = effect(() => { void r.value; fires++; });
      v.value = { x: 5, y: 5 };
      check("4-op chain: single re-fire", fires === 2);
      stop();
    }

    section("Equivalence: method chain vs derive");
    {
      const v = vec(1, 2);
      const b = vec(10, 20);
      const m = v.add(b).scale(2);
      const d = v.derive(c => c.add(b).scale(2));
      check("initial values agree", m.value.x === d.value.x);
      b.value = { x: 100, y: 200 };
      check("after b change", m.value.x === d.value.x);
      v.value = { x: 0, y: 0 };
      check("after v change", m.value.x === d.value.x);
    }

    section("classOf + per-trait accessors");
    {
      const v = vec(3, 4);
      const klass = classOf(v);
      check("classOf returns Vec", klass === Vec);
      check("Vec.prototype[LINEAR] exists", !!Vec.prototype[LINEAR]);
      const linear = linearOf(v)!;
      const sum = linear.add({ x: 1, y: 1 }, { x: 2, y: 3 });
      check("linearOf(v).add works", sum.x === 3);
    }

    section("instanceof identity — direct + derived");
    // Regression: derived(Cls, ...) must produce instances that pass
    // `instanceof Cls`, because consumers use this to narrow (e.g.
    // `path(start: Vec | Vec[])` distinguishes via `instanceof Vec`).
    {
      const lit = vec(1, 2);
      check("vec(...) instanceof Vec", lit instanceof Vec);
      const der = lit.add({ x: 1, y: 1 });
      check("derived Vec instanceof Vec", der instanceof Vec);
      check("derived Vec instanceof Signal too", der instanceof Signal);
      const field = lit.x;
      check("vec.x (field lens) instanceof Num", field instanceof Num);

      const b = box(0, 0, 10, 10);
      check("box(...) instanceof Box", b instanceof Box);
      const bDer = b.expand(5);
      check("derived Box instanceof Box", bDer instanceof Box);
      check("box.center instanceof Vec", b.center instanceof Vec);
    }

    section("requireLinear / requireLerp");
    {
      const v = vec(0, 0);
      const linear = requireLinear(v);
      const lerp = requireLerp(v);
      check("requireLinear typed + works", linear.add({ x: 1, y: 2 }, { x: 3, y: 4 }).x === 4);
      check("requireLerp typed + works", lerp({ x: 0, y: 0 }, { x: 10, y: 10 }, 0.5).x === 5);
      const plain = signal(42);
      let threw = false;
      try { requireLinear(plain); } catch { threw = true; }
      check("requireLinear throws on plain signal", threw);
      check("linearOf returns undefined on plain signal", linearOf(plain) === undefined);
    }

    section("traits + classOf on derived/lensed cells");
    {
      const v = vec(1, 2);
      const d = v.add({ x: 3, y: 4 });
      check("classOf(derived).name === 'Vec'", classOf(d).name === "Vec");
      const linear = requireLinear(d);
      check("linear dispatch on derived works", linear.add({ x: 1, y: 1 }, { x: 2, y: 3 }).y === 4);
      const tr = transform();
      check("classOf(tr.translate).name === 'Vec'", classOf(tr.translate).name === "Vec");
      const numLinear = requireLinear(tr.opacity);
      check("linear dispatch on field lens works", numLinear.add(0.2, 0.3) === 0.5);
    }

    section("Transform: composite with typed nested fields");
    {
      const tr = transform();
      check("default translate.x = 0", tr.value.translate.x === 0);
      check("default scale.x = 1", tr.value.scale.x === 1);
      tr.translate.x.value = 50;
      check("nested write through translate.x", tr.value.translate.x === 50);
      const tr2 = transform({ opacity: 0.5 });
      check("partial init", tr2.value.opacity === 0.5);
      check("other fields default", tr2.value.translate.x === 0);
    }

    section("Num operations");
    {
      const n = num(5);
      check("Num.add(3)", n.add(3).value === 8);
      check("Num.clamp(0, 4)", n.clamp(0, 4).value === 4);
      check("Num.scale(2)", n.scale(2).value === 10);
      check("Num.prototype[LINEAR].add", Num.prototype[LINEAR]!.add(2, 3) === 5);
    }

    section("Color");
    {
      const c = rgb(0.5, 0.25, 0.75);
      check("rgb()", c.value.r === 0.5 && c.value.a === 1);
      check("luminance derived", typeof c.luminance.value === "number");
      const c2 = c.scale(2);
      check("scale → Color", c2.value.r === 1);
    }

    section("Box");
    {
      const b = box(10, 20, 30, 40);
      check("box construct", b.value.x === 10 && b.value.w === 30);
      check("Box.area", b.area.value === 1200);
      check("Box.expand(5)", b.expand(5).value.w === 40);
    }

    section("Function-typed T: stored as plain value");
    {
      const fn = () => 99;
      const s = signal<() => number>(fn);
      check("signal(fn): fn stored as the value", s.value === fn);
      check("invoking the value calls the original fn", s.value() === 99);
    }
  });
});
