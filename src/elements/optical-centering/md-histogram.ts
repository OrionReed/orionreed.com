// md-histogram.ts — `Array<Num> → Array<BinCount>`.
//
// A coarsening aggregate: continuous samples projected onto a partition.
// Forward drops position and keeps counts; backward is MASS TRANSPORT —
// drag a bar's height and the fewest samples cross the nearest boundary
// to match. The aggregate sibling of `quantize`, with the same min-norm
// spirit as `mix`'s delta distribution.
//
// Each bar height is a real writable lens `Num.lens(samples, count, transport)`:
// read = how many samples fall in this bin; write = move boundary-nearest
// samples in or out until the count matches.

import {
  Anchor,
  Diagram,
  derive,
  handle,
  label,
  line,
  type Mount,
  Num,
  num,
  rect,
  Vec,
  vec,
  type Writable,
} from "../../minim";

const W = 720;
const H = 300;
const K = 6; // bin count
const AX0 = 70;
const AX1 = 650;
const DOTY = 96;
const BASE = 250;
const UNIT = 17; // px per sample in a bar

const FILLS = ["#5b8def", "#e8833a", "#3aae6f", "#b563d6", "#d6a23a", "#d65c6f"];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const xOf = (v: number) => AX0 + clamp01(v) * (AX1 - AX0);
const vOf = (x: number) => (x - AX0) / (AX1 - AX0);
const binOf = (v: number) => Math.min(K - 1, Math.max(0, Math.floor(clamp01(v) * K)));

const INIT = [
  0.04, 0.08, 0.12, 0.19, 0.21, 0.23, 0.29, 0.34, 0.37, 0.42, 0.46, 0.51, 0.55, 0.62, 0.66, 0.71,
  0.74, 0.79, 0.83, 0.88, 0.92, 0.96,
];

/** Backward pass: move the fewest samples across the nearest boundary so
 *  bin `i` ends up with ~`target` samples. Returns per-sample updates. */
function transport(vals: readonly number[], i: number, target: number): (number | undefined)[] {
  const bw = 1 / K;
  const lo = i * bw;
  const hi = (i + 1) * bw;
  const out = vals.map(() => undefined as number | undefined);
  const cur = vals.filter(v => binOf(v) === i).length;
  const diff = Math.round(Math.max(0, target)) - cur;

  if (diff > 0) {
    // Pull in the nearest outsiders.
    const cand = vals
      .map((v, idx) => ({ idx, v, d: v < lo ? lo - v : v - hi }))
      .filter(o => binOf(o.v) !== i)
      .sort((a, b) => a.d - b.d);
    for (let n = 0; n < diff && n < cand.length; n++) {
      const c = cand[n]!;
      out[c.idx] = c.v < lo ? lo + bw * 0.25 : hi - bw * 0.25;
    }
  } else if (diff < 0) {
    // Push out the samples closest to a usable boundary.
    const cand = vals
      .map((v, idx) => ({
        idx,
        v,
        dLeft: i > 0 ? v - lo : Number.POSITIVE_INFINITY,
        dRight: i < K - 1 ? hi - v : Number.POSITIVE_INFINITY,
      }))
      .filter(o => binOf(o.v) === i)
      .sort((a, b) => Math.min(a.dLeft, a.dRight) - Math.min(b.dLeft, b.dRight));
    for (let n = 0; n < -diff && n < cand.length; n++) {
      const c = cand[n]!;
      out[c.idx] = clamp01(c.dLeft <= c.dRight ? lo - bw * 0.25 : hi + bw * 0.25);
    }
  }
  return out;
}

export class MdHistogram extends Diagram {
  static styles = `text { pointer-events: none; }`;
  protected scene(s: Mount): void {
    const view = this.view(W, H);
    const samples: Writable<Num>[] = INIT.map(v => num(v));

    // Per-bin count lens: read = samples in bin; write = mass transport.
    const counts = Array.from({ length: K }, (_, i) =>
      Num.lens(
        samples,
        (vs: readonly number[]) => vs.filter(v => binOf(v) === i).length,
        (target, vs) => transport(vs as readonly number[], i, target) as never,
      ),
    );

    const bw = (AX1 - AX0) / K;

    // ── Bins: alternating shade, bars, count, drag handle ───────────
    for (let i = 0; i < K; i++) {
      const x0 = AX0 + i * bw;
      const cx = x0 + bw / 2;
      const ci = counts[i]!;
      s(
        rect(x0, DOTY - 26, bw, BASE - (DOTY - 26), {
          fill: i % 2 === 0 ? "rgba(127,127,127,0.05)" : "transparent",
          stroke: "transparent",
        }),
        rect(
          x0 + 6,
          derive(() => BASE - ci.value * UNIT),
          bw - 12,
          derive(() => ci.value * UNIT),
          { fill: FILLS[i]!, opacity: 0.85, stroke: FILLS[i]!, thin: true, corner: 3 },
        ),
        label(
          Vec.derive(() => ({ x: cx, y: BASE - ci.value * UNIT - 10 })),
          derive(() => `${ci.value}`),
          { size: 12, bold: true, align: Anchor.Center, fill: FILLS[i]! },
        ),
      );
      // Drag handle on the bar's top edge → writes the count.
      const top = Vec.lens(
        [ci] as const,
        ([c]) => ({ x: cx, y: BASE - c * UNIT }),
        (p, [_c]) => [(BASE - p.y) / UNIT],
      );
      s(handle(top, { fill: FILLS[i]!, r: 6, cursor: "ns-resize" }));
    }

    // Baseline + bin boundaries.
    s(line(vec(AX0, BASE), vec(AX1, BASE), { thin: true, opacity: 0.5 }));
    for (let i = 0; i <= K; i++) {
      const x = AX0 + i * bw;
      s(line(vec(x, BASE), vec(x, BASE + 6), { thin: true, opacity: 0.4 }));
    }

    // ── Samples on the axis (drag = re-bin live) ────────────────────
    s(line(vec(AX0, DOTY), vec(AX1, DOTY), { thin: true, opacity: 0.3 }));
    samples.forEach(sample => {
      const pos = Vec.lens(
        [sample] as const,
        ([v]) => ({ x: xOf(v), y: DOTY }),
        p => [clamp01(vOf(p.x))],
      );
      s(handle(pos, { fill: derive(() => FILLS[binOf(sample.value)]!), r: 5 }));
    });

    s(
      label(view.top.down(18), "Array<Num> → Array<BinCount> — samples projected onto a partition"),
      label(vec(AX0, DOTY - 22), "samples", { size: 10, align: Anchor.Left, opacity: 0.6 }),
      label(
        view.bottom.up(12),
        "drag a sample = re-bin (forward) · drag a bar = mass transport: fewest samples cross the nearest boundary (backward)",
        { size: 10 },
      ),
    );
  }
}
