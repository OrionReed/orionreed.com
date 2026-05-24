// Perf bench: unified lens vs current (through / lensTo / fanin / aggregates).
//
// IMPORTANT METHODOLOGY NOTE
// ---------------------------
// V8's inline caches go megamorphic when the SAME describe-block test
// builds multiple cells with different shapes (e.g., Num lens then
// Signal lens then Num lens again). The first bench in a process
// gets ~0.80ms; subsequent benches in the same process for the same
// hot path get ~1.40ms+ because the IC went megamorphic.
//
// To get fair numbers, run each bench in ISOLATION via:
//
//     npx vitest run perf.bench.test.ts -t "<test name>"
//
// Or use the helper script in this directory.
//
// In a vitest run that does ALL tests sequentially, the FIRST one
// reflects parity; the rest are noise.

import { describe, it } from "vitest";
import {
  centroidLens as centroidLensOld,
  fanin,
  meanLens as meanLensOld,
  Num,
  num,
  Vec,
  vec,
} from "../../signals";
import { centroidLens, classLens, derive, lens, meanLens } from "..";

const N = 200_000;
const RUNS = 8;

function timed(label: string, fn: () => void): void {
  fn();
  fn();
  const times: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const min = Math.min(...times);
  // biome-ignore lint/suspicious/noConsole: bench output
  console.info(
    `  ${label.padEnd(54)}  min ${min.toFixed(2).padStart(7)}ms  (${((min * 1000) / N).toFixed(3)}µs/op)`,
  );
}

// ─── Read benches (pure read; less prone to IC pollution) ────────

describe("perf: read paths", () => {
  it("1-input through read", () => {
    const a = num(0);
    const cell = a.through(
      x => x * 2 + 1,
      target => (target - 1) / 2,
    );
    timed("[old]   1-input through read", () => {
      a.value = 1;
      let s = 0;
      for (let i = 0; i < N; i++) s += cell.value;
      if (s < -1e30) throw new Error("");
    });
  });

  it("1-input lens read", () => {
    const a = num(0);
    const cell = lens(
      a,
      x => x * 2 + 1,
      target => (target - 1) / 2,
    );
    timed("[new]   1-input lens read", () => {
      a.value = 1;
      let s = 0;
      for (let i = 0; i < N; i++) s += cell.value;
      if (s < -1e30) throw new Error("");
    });
  });

  it("3-contributor fanin read", () => {
    const a = num(1),
      b = num(2),
      c = num(3);
    const cell = fanin(Num, [a, b, c] as const, vals => vals[0] + vals[1] + vals[2]);
    timed("[old]   fanin 3-contrib read", () => {
      a.value = 1;
      let s = 0;
      for (let i = 0; i < N; i++) s += cell.value;
      if (s < -1e30) throw new Error("");
    });
  });

  it("3-contributor lens read", () => {
    const a = num(1),
      b = num(2),
      c = num(3);
    const cell = derive([a, b, c], vals => vals[0]! + vals[1]! + vals[2]!);
    timed("[new]   lens 3-contrib read", () => {
      a.value = 1;
      let s = 0;
      for (let i = 0; i < N; i++) s += cell.value;
      if (s < -1e30) throw new Error("");
    });
  });
});

// ─── Write benches (sensitive to IC pollution; isolate via -t) ───

describe("perf: 1-input write (run alone via -t)", () => {
  it("through write", () => {
    const a = num(0);
    const cell = a.through(
      x => x + 1,
      target => target - 1,
    );
    timed("[old]   1-input through write", () => {
      for (let i = 0; i < N; i++) cell.value = i;
    });
  });

  it("lens write Signal-cls", () => {
    const a = num(0);
    const cell = lens(
      a,
      x => x + 1,
      target => target - 1,
    );
    timed("[new]   1-input lens write", () => {
      for (let i = 0; i < N; i++) cell.value = i;
    });
  });

  it("classLens write Num-cls", () => {
    const a = num(0);
    const cell = classLens(
      Num,
      a,
      x => x + 1,
      target => target - 1,
    );
    timed("[new]   1-input classLens write", () => {
      for (let i = 0; i < N; i++) cell.value = i;
    });
  });
});

describe("perf: N-input write (run alone via -t)", () => {
  it("fanin 3-contrib write", () => {
    const a = num(0),
      b = num(0),
      c = num(0);
    const cell = fanin(
      Num,
      [a, b, c] as const,
      vals => (vals[0] + vals[1] + vals[2]) / 3,
      (target: number) => [target, target, target] as const,
    );
    timed("[old]   fanin 3-contrib write", () => {
      for (let i = 0; i < N; i++) cell.value = i;
    });
  });

  it("lens 3-contrib write", () => {
    const a = num(0),
      b = num(0),
      c = num(0);
    const cell = lens(
      [a, b, c],
      vals => (vals[0]! + vals[1]! + vals[2]!) / 3,
      target => [target, target, target],
    );
    timed("[new]   lens 3-contrib write (Cls=Signal)", () => {
      for (let i = 0; i < N; i++) cell.value = i;
    });
  });

  it("classLens 3-contrib write Num-cls", () => {
    const a = num(0),
      b = num(0),
      c = num(0);
    const cell = classLens(
      Num,
      [a, b, c],
      vals => (vals[0]! + vals[1]! + vals[2]!) / 3,
      target => [target, target, target],
    );
    timed("[new]   classLens 3-contrib write (Cls=Num)", () => {
      for (let i = 0; i < N; i++) cell.value = i;
    });
  });

  it("meanLens 3-input write old", () => {
    const a = num(0),
      b = num(0),
      c = num(0);
    const cell = meanLensOld(Num, [a, b, c]);
    timed("[old]   meanLens write", () => {
      for (let i = 0; i < N; i++) cell.value = i;
    });
  });

  it("meanLens 3-input write new", () => {
    const a = num(0),
      b = num(0),
      c = num(0);
    const cell = meanLens(Num, [a, b, c]);
    timed("[new]   meanLens write", () => {
      for (let i = 0; i < N; i++) cell.value = i;
    });
  });

  it("centroidLens 5-input write old", () => {
    const vs = Array.from({ length: 5 }, () => vec(0, 0));
    const cell = centroidLensOld(vs);
    timed("[old]   centroidLens 5-write", () => {
      for (let i = 0; i < N; i++) cell.value = { x: i, y: i };
    });
  });

  it("centroidLens 5-input write new", () => {
    const vs = Array.from({ length: 5 }, () => vec(0, 0));
    const cell = centroidLens(vs);
    timed("[new]   centroidLens 5-write", () => {
      for (let i = 0; i < N; i++) cell.value = { x: i, y: i };
    });
  });
});
