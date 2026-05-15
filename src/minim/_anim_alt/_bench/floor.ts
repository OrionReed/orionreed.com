// Floor measurements: what's the absolute lower bound on N callbacks/frame?
// Compares the raw JS cost of various dispatch shapes against v6/v21's
// real cost on the same N×60 frame workload.

import "./raf-polyfill";
import { bench, group, run, do_not_optimize } from "mitata";

const N = 1000;
const FRAMES = 60;

group("floor: N=1000 × 60 frames, accumulate dt", () => {
  bench("flat closure array, alive flag in closure", () => {
    let acc = 0;
    const cbs: Array<((dt: number) => void)> = [];
    for (let i = 0; i < N; i++) {
      let alive = true;
      cbs.push((dt) => { if (alive) acc += dt; });
    }
    const dt = 1 / 60;
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < cbs.length; i++) cbs[i](dt);
    }
    do_not_optimize(acc);
  }).baseline(true);

  bench("flat closure array, parallel Uint8Array alive", () => {
    let acc = 0;
    const cbs: Array<((dt: number) => void)> = [];
    const alive = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      alive[i] = 1;
      cbs.push((dt) => { acc += dt; });
    }
    const dt = 1 / 60;
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < cbs.length; i++) {
        if (alive[i]) cbs[i](dt);
      }
    }
    do_not_optimize(acc);
  });

  bench("object array, .tick(dt) polymorphic call", () => {
    let acc = 0;
    interface T { tick(dt: number): void; }
    const arr: T[] = [];
    for (let i = 0; i < N; i++) {
      arr.push({ tick: (dt) => { acc += dt; } });
    }
    const dt = 1 / 60;
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < arr.length; i++) arr[i].tick(dt);
    }
    do_not_optimize(acc);
  });

  bench("generator: gen.next(dt) per frame (worst case)", () => {
    let acc = 0;
    function* worker(): Generator<undefined, void, number> {
      while (true) { const dt = yield; acc += dt; }
    }
    const gens: Generator<undefined, void, number>[] = [];
    for (let i = 0; i < N; i++) {
      const g = worker();
      g.next(); // prime
      gens.push(g);
    }
    const dt = 1 / 60;
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < gens.length; i++) gens[i].next(dt);
    }
    do_not_optimize(acc);
  });

  bench("class instance, monomorphic .tick", () => {
    let acc = 0;
    class T {
      tick(dt: number): void { acc += dt; }
    }
    const arr: T[] = [];
    for (let i = 0; i < N; i++) arr.push(new T());
    const dt = 1 / 60;
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < arr.length; i++) arr[i].tick(dt);
    }
    do_not_optimize(acc);
  });

  bench("typed-array indexed scalar: arr[i] += dt", () => {
    const arr = new Float64Array(N);
    const dt = 1 / 60;
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < arr.length; i++) arr[i] += dt;
    }
    do_not_optimize(arr[0]);
  });
});

await run({ format: "mitata" });
