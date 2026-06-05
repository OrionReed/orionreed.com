// Backward no-op semantics — three distinct "stop" rules, and which is the
// sound dual of the forward direction.
//
// Forward memoization (the dual we're mirroring):
//   a source changes → walk DOWN; at each node, recompute; if the node's value
//   is unchanged, STOP that branch. Per-node, concrete, sound.
//
// Backward has THREE candidate stop rules:
//   (1) SOURCE   — resolve the whole put-chain; propagate iff the SOURCE moved.
//   (2) PER-HOP  — walk UP; at each ancestor, if its value is unchanged, STOP.
//                  The true dual of forward memoization.
//   (3) VIEW     — resolve, recompute the WRITTEN view; if the view didn't
//                  move, discard the whole write.  (The seductive "only
//                  propagate if the view actually changes" rule.)
//
// They COINCIDE when absorption is encoded in `put` (clamp/quantise the common
// case). They DIVERGE under lossy-forward, and that divergence is where (3)
// turns out to be unsound and (2) beats (1).

type Hop = { fwd: (x: number) => number; put: (t: number) => number };

/** value at each level: [source, h0.fwd(src), h1.fwd(...), ... , view]. */
function levels(src: number, hops: Hop[]): number[] {
  const v = [src];
  for (const h of hops) v.push(h.fwd(v[v.length - 1]));
  return v;
}

const work = { puts: 0 };

/** (1) source-level: fold the whole put-chain, compare the source. */
function writeSource(src: number, hops: Hop[], target: number): number {
  let t = target;
  for (let i = hops.length - 1; i >= 0; i--) {
    work.puts++;
    t = hops[i].put(t);
  }
  return Object.is(t, src) ? src : t; // source-level no-op
}

/** (2) per-hop: walk up; the instant an ancestor's value is unchanged, stop
 *  and return the EXACT current source (no drift, no further put work). */
function writePerHop(src: number, hops: Hop[], target: number): number {
  const v = levels(src, hops);
  let t = target;
  for (let i = hops.length - 1; i >= 0; i--) {
    if (Object.is(t, v[i + 1])) return src; // ancestor unchanged → exact no-op
    work.puts++;
    t = hops[i].put(t);
  }
  return Object.is(t, src) ? src : t;
}

/** (3) view-level: resolve via put-chain, then re-derive the written view;
 *  if the view round-trips to its old value, discard the entire write. */
function writeView(src: number, hops: Hop[], target: number): number {
  const oldView = levels(src, hops)[hops.length];
  let t = target;
  for (let i = hops.length - 1; i >= 0; i--) {
    work.puts++;
    t = hops[i].put(t);
  }
  let view = t;
  for (const h of hops) view = h.fwd(view);
  return Object.is(view, oldView) ? src : t; // view-level no-op
}

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("backward no-op semantics\n");

// ── Case A: clamp/quantise encoded in `put` (the common, recommended case).
// All three rules AGREE: a sub-quantum nudge does not move the source.
{
  const step = 10;
  const q: Hop = { fwd: (x) => x, put: (t) => Math.round(t / step) * step };
  const hops = [q];
  const src = 100;
  console.log("A. quantise-in-put (sub-quantum nudge):");
  check("(1) source: 103 absorbed", writeSource(src, hops, 103) === 100);
  check("(2) perhop: 103 absorbed", writePerHop(src, hops, 103) === 100);
  check("(3) view:   103 absorbed", writeView(src, hops, 103) === 100);
  check("…and 108 crosses the quantum", writeSource(src, hops, 108) === 110);
}

// ── Case B: lossy in FWD, absorption NOT in put, with a SIBLING view W=raw.
// This is where (3) FALSE-SKIPS the sibling. S=100; V clamps display to ≤100,
// W shows raw S. Write V=150.
{
  const Vhops = [{ fwd: (x: number) => Math.min(100, x), put: (t: number) => t }];
  const src = 100;
  console.log("\nB. lossy-in-fwd with sibling W = raw source (write V=150):");
  const s1 = writeSource(src, Vhops, 150);
  const s3 = writeView(src, Vhops, 150);
  check("(1) source: S→150  ⇒ sibling W would see 150", s1 === 150, `S=${s1}`);
  check("(3) view:   S stays 100 ⇒ sibling W frozen at 100", s3 === 100, `S=${s3}`);
  check(
    "→ (3) is UNSOUND: a local V-write silently suppresses W",
    s1 !== s3,
    "the gate ignores the rest of the graph",
  );
}

// ── Case C: FP drift. Writing the CURRENT view value MUST be a no-op (GetPut).
// (1) drifts through the chain and SPURIOUSLY fires; (2) returns exact source.
{
  const h: Hop = { fwd: (x) => x * 0.1, put: (t) => t * 10 };
  const hops = [h, h, h];
  const src = 7;
  const view = levels(src, hops)[3]; // 0.007 (with FP error)
  console.log(`\nC. write current view back (view=${view}); GetPut ⇒ no-op:`);
  work.puts = 0;
  const s1 = writeSource(src, hops, view);
  const p1 = work.puts;
  work.puts = 0;
  const s2 = writePerHop(src, hops, view);
  const p2 = work.puts;
  check("(1) source: drifts ≠ 7 → spurious over-fire", !Object.is(s1, 7), `S=${s1}`);
  check("(2) perhop: EXACT 7 → no fire, no drift", Object.is(s2, 7), `S=${s2}`);
  check(`(2) perhop also does less work: ${p2} puts vs ${p1}`, p2 < p1, `${p2} < ${p1}`);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);

export {};
