// Workload definitions, parameterised by an Engine module shape.
// Each scenario is expressed in the most idiomatic form for each
// engine. Where engines differ in capability (yield array support,
// etc), the scenario uses an equivalent userland combinator.

import type { Engine } from "./harness";

export interface EngineMod {
  Anim: new () => {
    run: (g: any) => () => void;
    step: (dt: number) => void;
    stop: () => void;
  };
  suspend?: any;
  drive?: (step: (dt: number, t: number) => boolean | void) => any;
  /** Userland combinator for parallel (used by engines that don't
   *  support yield-array). */
  all?: (...gens: any[]) => any;
}

function genericDrive(step: (dt: number, t: number) => boolean | void) {
  return (function* () {
    let t = 0;
    while (true) {
      const dt: number = yield;
      t += dt;
      if (step(dt, t) === false) return;
    }
  })();
}

function driveOf(eng: Engine): (s: (dt: number, t: number) => boolean | void) => any {
  const m = eng.build() as EngineMod;
  return m.drive ?? genericDrive;
}

export function scenarios() {
  const drive = (eng: Engine) => driveOf(eng);

  return [
    {
      name: "raw-yield   N=1000 60f",
      for: (eng: Engine) => () => {
        const m = eng.build() as EngineMod;
        const e = new m.Anim();
        let acc = 0;
        function* worker(): any { while (true) { const dt: number = yield; acc += dt; } }
        for (let i = 0; i < 1000; i++) e.run(worker);
        for (let f = 0; f < 60; f++) e.step(1 / 60);
        e.stop();
        return acc;
      },
    },
    {
      name: "drive-loop  N=1000 60f",
      for: (eng: Engine) => {
        const d = drive(eng);
        return () => {
          const m = eng.build() as EngineMod;
          const e = new m.Anim();
          let acc = 0;
          for (let i = 0; i < 1000; i++) e.run(d((dt) => { acc += dt; }));
          for (let f = 0; f < 60; f++) e.step(1 / 60);
          e.stop();
          return acc;
        };
      },
    },
    {
      name: "spring-sim  N=1000 60f",
      for: (eng: Engine) => {
        const d = drive(eng);
        return () => {
          const m = eng.build() as EngineMod;
          const e = new m.Anim();
          const xs = new Float64Array(1000);
          const vs = new Float64Array(1000);
          for (let i = 0; i < 1000; i++) {
            const idx = i;
            e.run(d((dt) => {
              const force = (1 - xs[idx]) * 170;
              const drag = -26 * vs[idx];
              vs[idx] += (force + drag) * dt;
              xs[idx] += vs[idx] * dt;
            }));
          }
          for (let f = 0; f < 60; f++) e.step(1 / 60);
          e.stop();
          return xs[0];
        };
      },
    },
    {
      name: "tween       N=500  60f",
      for: (eng: Engine) => {
        const d = drive(eng);
        return () => {
          const m = eng.build() as EngineMod;
          const e = new m.Anim();
          const out = new Float64Array(500);
          for (let i = 0; i < 500; i++) {
            const idx = i;
            e.run(d((_dt, t) => {
              if (t >= 1) { out[idx] = 1; return false; }
              out[idx] = t;
            }));
          }
          for (let f = 0; f < 60; f++) e.step(1 / 60);
          e.stop();
        };
      },
    },
    {
      name: "sleep-idle  500/100/30f",
      for: (eng: Engine) => () => {
        const m = eng.build() as EngineMod;
        const e = new m.Anim();
        function* sleeper(): any { yield 0.5; }
        function* driver(): any { while (true) yield; }
        for (let i = 0; i < 500; i++) e.run(sleeper);
        for (let i = 0; i < 100; i++) e.run(driver);
        for (let f = 0; f < 30; f++) e.step(1 / 60);
        e.stop();
      },
    },
    {
      name: "spawn+complete N=1000",
      for: (eng: Engine) => () => {
        const m = eng.build() as EngineMod;
        const e = new m.Anim();
        function* worker(): any {}
        for (let i = 0; i < 1000; i++) e.run(worker);
        e.step(0);
        e.stop();
      },
    },
    {
      name: "spawn+cancel  N=1000",
      for: (eng: Engine) => () => {
        const m = eng.build() as EngineMod;
        const e = new m.Anim();
        function* worker(): any { yield; }
        const ds: (() => void)[] = [];
        for (let i = 0; i < 1000; i++) ds.push(e.run(worker));
        for (const d of ds) d();
        e.stop();
      },
    },
    {
      name: "suspend+wake  N=500",
      for: (eng: Engine) => {
        return () => {
          const m = eng.build() as EngineMod;
          const e = new m.Anim();
          const wakes: Array<() => void> = [];
          function* worker(): any {
            yield* m.suspend((wake: () => void) => {
              wakes.push(wake);
              return () => {};
            });
          }
          for (let i = 0; i < 500; i++) e.run(worker);
          e.step(1 / 60);
          for (const w of wakes) w();
          e.step(1 / 60);
          e.stop();
        };
      },
    },
    {
      name: "parallel    N=100 K=10",
      for: (eng: Engine) => () => {
        const m = eng.build() as EngineMod;
        const e = new m.Anim();
        function* child(): any { yield; }
        function* worker(): any {
          if (m.all) {
            const kids = Array.from({ length: 10 }, () => child());
            yield* m.all(...kids);
          } else {
            const kids = Array.from({ length: 10 }, () => child());
            yield kids;
          }
        }
        for (let i = 0; i < 100; i++) e.run(worker);
        e.step(1 / 60); e.step(1 / 60); e.step(1 / 60);
        e.stop();
      },
    },
    {
      name: "deep yield* N=200 d=8",
      for: (eng: Engine) => () => {
        const m = eng.build() as EngineMod;
        const e = new m.Anim();
        function* leaf(): any { yield; }
        function makeChain(d: number): () => any {
          let cur: () => any = leaf;
          for (let i = 0; i < d; i++) {
            const inner = cur;
            cur = function* (): any { yield* inner(); };
          }
          return cur;
        }
        const f = makeChain(8);
        for (let i = 0; i < 200; i++) e.run(f);
        e.step(1 / 60); e.step(1 / 60);
        e.stop();
      },
    },
    {
      name: "mixed       N=500 120f",
      for: (eng: Engine) => {
        const d = drive(eng);
        return () => {
          const m = eng.build() as EngineMod;
          const e = new m.Anim();
          let dummy = 0;
          const Ndrive = 150, Nsleep = 150, Nsuspend = 100, Nshort = 100;
          for (let i = 0; i < Ndrive; i++) e.run(d((dt) => { dummy += dt; }));
          function* sleeper(): any { yield 0.5; }
          for (let i = 0; i < Nsleep; i++) e.run(sleeper);
          const wakes: Array<() => void> = [];
          function* susp(): any {
            yield* m.suspend((w: () => void) => { wakes.push(w); return () => {}; });
          }
          for (let i = 0; i < Nsuspend; i++) e.run(susp);
          function* shortLived(): any { yield; yield; }
          for (let i = 0; i < Nshort; i++) e.run(shortLived);
          for (let f = 0; f < 120; f++) {
            e.step(1 / 60);
            if (f % 10 === 0 && wakes.length > 0) wakes.pop()!();
          }
          e.stop();
          return dummy;
        };
      },
    },
    // Realistic composition: 100 buttons each running an interactive
    // loop of suspend → tween → tween → sleep, like a UI animation.
    {
      name: "ui-buttons  N=100 200f",
      for: (eng: Engine) => {
        const d = drive(eng);
        return () => {
          const m = eng.build() as EngineMod;
          const e = new m.Anim();
          let acc = 0;
          // wakes are popped to simulate user clicks
          const wakes: Array<() => void> = [];
          function* clickWait(): any {
            yield* m.suspend((w: () => void) => { wakes.push(w); return () => {}; });
          }
          function* button(): any {
            for (let i = 0; i < 5; i++) {
              yield* clickWait();
              yield* d((_dt: number, t: number) => { if (t >= 0.1) return false; acc += 1; });
              yield* d((_dt: number, t: number) => { if (t >= 0.2) return false; acc += 1; });
              yield 0.3;
            }
          }
          for (let i = 0; i < 100; i++) e.run(button);
          for (let f = 0; f < 200; f++) {
            e.step(1 / 60);
            // randomly fire 5 wakes per frame
            for (let k = 0; k < 5 && wakes.length; k++) wakes.shift()!();
          }
          e.stop();
          return acc;
        };
      },
    },
  ];
}
