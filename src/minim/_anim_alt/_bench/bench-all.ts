// Best-of-both bench orchestrator.
//
// • Per-process isolation (other agent's bench-run.sh insight): each
//   engine runs in a fresh node process to avoid JIT polymorphism, IC
//   degradation, and GC cross-contamination between engines.
// • p25 / p50 / p75 / IQR% output (this agent's harness insight):
//   medians are more trustworthy than means for noisy small workloads.
// • Sorted by p50 within each scenario, with `vs best` column.
//
// Usage:
//   node node_modules/.bin/vite-node \
//     src/minim/_anim_alt/_bench/bench-all.ts [engine1 engine2 ...]
//
// Default engines: all the candidates worth comparing.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ENGINES_DEFAULT = ["current", "v6", "v21", "v30", "v31", "mini", "simple", "final"];
const argEngines = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const engines = argEngines.length > 0 ? argEngines : ENGINES_DEFAULT;

const benchOne = resolve("src/minim/_anim_alt/_bench/bench-one.ts");
const viteNode = resolve("node_modules/.bin/vite-node");

interface Stat { min: number; p25: number; p50: number; p75: number; avg: number; }

const results: Record<string /* engine */, Record<string /* scenario */, Stat>> = {};

for (const engine of engines) {
  process.stderr.write(`>>> ${engine.padEnd(8)} `);
  const t0 = Date.now();
  const r = spawnSync(
    "node",
    ["--expose-gc", viteNode, benchOne, engine],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (r.status !== 0) {
    process.stderr.write(`FAILED (${r.status})\n${r.stderr}\n`);
    continue;
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`(${elapsed}s)\n`);

  results[engine] = {};
  const lines = r.stdout.split("\n");
  for (const ln of lines) {
    if (!ln || ln.startsWith("#")) continue;
    if (ln.startsWith("scenario\t")) continue;
    const cols = ln.split("\t");
    if (cols.length < 6) continue;
    const [name, mn, p25, p50, p75, avg] = cols;
    if (mn === "NA") continue;
    results[engine][name] = {
      min: +mn,
      p25: +p25,
      p50: +p50,
      p75: +p75,
      avg: +avg,
    };
  }
}

// Aggregate: scenario → list of (engine, stats), sorted by p50.
const allScenarios = new Set<string>();
for (const eng of engines) for (const sc of Object.keys(results[eng] ?? {})) allScenarios.add(sc);

function fmt(ns: number): string {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(2)} µs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}

console.log();
console.log(`Per-process bench: ${engines.length} engines × ${allScenarios.size} scenarios`);
console.log(`(min/p25/p50/p75 from mitata; per-process isolation; sorted by p50)\n`);

for (const sc of allScenarios) {
  const rows: Array<{ engine: string; s: Stat }> = [];
  for (const eng of engines) {
    const s = results[eng]?.[sc];
    if (s) rows.push({ engine: eng, s });
  }
  if (rows.length === 0) continue;
  rows.sort((a, b) => a.s.p50 - b.s.p50);
  const best = rows[0].s.p50;

  console.log(`• ${sc}`);
  console.log(`  engine    min          p50          p25–p75               iqr%   vs best`);
  console.log(`  --------  -----------  -----------  --------------------  -----  -------`);
  for (const r of rows) {
    const iqr = ((r.s.p75 - r.s.p25) / r.s.p50) * 100;
    const rel = (r.s.p50 / best).toFixed(2) + "×";
    console.log(
      `  ${r.engine.padEnd(8)}  ${fmt(r.s.min).padStart(11)}  ${fmt(r.s.p50).padStart(11)}  ${(fmt(r.s.p25) + " – " + fmt(r.s.p75)).padEnd(20)}  ${iqr.toFixed(1).padStart(4)}%  ${rel}`,
    );
  }
  console.log();
}

// Win matrix: count outright p50 wins per engine.
const wins: Record<string, number> = {};
for (const eng of engines) wins[eng] = 0;
for (const sc of allScenarios) {
  let bestEng = "";
  let bestP50 = Infinity;
  for (const eng of engines) {
    const s = results[eng]?.[sc];
    if (s && s.p50 < bestP50) { bestP50 = s.p50; bestEng = eng; }
  }
  if (bestEng) wins[bestEng]++;
}
console.log(`Wins by engine (most p50-wins across ${allScenarios.size} scenarios):`);
const winList = Object.entries(wins).sort((a, b) => b[1] - a[1]);
for (const [eng, w] of winList) console.log(`  ${eng.padEnd(8)}  ${w}`);
