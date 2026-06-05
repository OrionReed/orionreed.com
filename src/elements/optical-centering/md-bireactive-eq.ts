// md-bireactive-eq.ts — inverse EQ: drag the response curve, the filters solve.
//
// The whole point a forward DSP graph can't do: instead of turning band gains
// until it sounds right, you DRAG the response you want and `factor` solves the
// band gains that produce it (in 5-gain space ⇒ real-time). An `effect` pushes
// the solved gains onto live BiquadFilters; the AnalyserNode under the curve is
// the audible/visible confirmation. Bireactivity = the patch tunes itself.

import {
  cell,
  circle,
  Diagram,
  derive,
  drag,
  drive,
  effect,
  factor,
  label,
  line,
  type Mount,
  Num,
  num,
  pathD,
  rect,
  tokens,
  Vec,
  vec,
  type Writable,
} from "../../minim";
import { AudioEqGraph, type EqBand, responseDb } from "./eq-audio";

const W = 660;
const H = 392;
const PX0 = 56;
const PX1 = 620;

// EQ response plot (top): ±EQ_DB around 0 dB.
const EQ_TOP = 44;
const EQ_MID = 112;
const EQ_DB = 18;
const PX_PER_DB = (EQ_MID - EQ_TOP) / EQ_DB;

// Measured spectrum plot (bottom).
const SP_TOP = 214;
const SP_BOT = 330;
const SP_DB_HI = -18;
const SP_DB_LO = -96;

const LOGMIN = Math.log(20);
const LOGMAX = Math.log(20000);

const freqToX = (f: number): number => PX0 + ((Math.log(f) - LOGMIN) / (LOGMAX - LOGMIN)) * (PX1 - PX0);
const dbToY = (db: number): number => EQ_MID - db * PX_PER_DB;
const yToDb = (y: number): number => {
  const db = (EQ_MID - y) / PX_PER_DB;
  return db < -EQ_DB ? -EQ_DB : db > EQ_DB ? EQ_DB : db;
};
const specToY = (db: number): number => {
  const t = (db - SP_DB_LO) / (SP_DB_HI - SP_DB_LO);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return SP_BOT - c * (SP_BOT - SP_TOP);
};

const BANDS: EqBand[] = [
  { freq: 90, q: 1.0 },
  { freq: 260, q: 1.1 },
  { freq: 750, q: 1.1 },
  { freq: 2200, q: 1.1 },
  { freq: 6400, q: 1.0 },
];

const ACCENT = "#5b8def";
const MEASURED = "#e0a458";

export class MdBireactiveEq extends Diagram {
  #graph: AudioEqGraph | null = null;

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#graph?.dispose();
    this.#graph = null;
  }

  protected scene(s: Mount): void {
    const view = this.view(W, H);
    const graph = new AudioEqGraph(BANDS);
    this.#graph = graph;
    const fs = graph.ctx.sampleRate;

    // ── control plane: one gain cell per band, bound to a live filter ──
    const gains = BANDS.map(() => num(0));
    gains.forEach((g, i) => effect(() => graph.setGain(i, g.value)));

    // ── the inverse lens: response-at-band-center ⇄ band gains ──
    // Outputs = model response (dB) at each band center; writing one (a drag)
    // sends a sparse δ through factor's LSQ solve over the 5 gains.
    const outputs: Record<string, { Cls: typeof Num; fwd: (g: readonly number[]) => number }> = {};
    BANDS.forEach((b, j) => {
      outputs[`b${j}`] = { Cls: Num, fwd: (g: readonly number[]) => responseDb(b.freq, g, BANDS, fs) };
    });
    const curve = factor(gains, outputs as never, { converge: true, damping: 1e-3, maxIters: 8 }) as Record<
      string,
      Writable<Num>
    >;

    // ── grid + axes ──
    s(line(vec(PX0, dbToY(0)), vec(PX1, dbToY(0)), { thin: true, opacity: 0.35 }));
    s(line(vec(PX0, SP_BOT), vec(PX1, SP_BOT), { thin: true, opacity: 0.35 }));
    for (const f of [100, 1000, 10000]) {
      const x = freqToX(f);
      s(line(vec(x, EQ_TOP), vec(x, SP_BOT), { thin: true, opacity: 0.08 }));
      s(label(vec(x, SP_BOT + 12), f >= 1000 ? `${f / 1000}k` : `${f}`, { size: 9, opacity: 0.5 }));
    }

    // ── measured spectrum (bottom): live confirmation, display-only ──
    const buf = new Float32Array(graph.binCount);
    const frame = cell(0);
    this.anim.start(
      drive(() => {
        frame.value++;
      }),
    );
    const specD = derive(() => {
      frame.value; // tick dependency
      graph.spectrum(buf);
      let d = "";
      let started = false;
      for (let i = 1; i < buf.length; i++) {
        const f = graph.freqForBin(i);
        if (f < 20 || f > 20000) continue;
        const x = freqToX(f);
        const y = specToY(buf[i]!);
        d += started ? ` L ${x.toFixed(1)} ${y.toFixed(1)}` : `M ${x.toFixed(1)} ${y.toFixed(1)}`;
        started = true;
      }
      return d;
    });
    s(pathD(specD, { stroke: MEASURED, strokeWidth: 1.5, opacity: 0.85, cap: "round", join: "round" }));

    // ── EQ response curve (top): the closed-form model from the live gains ──
    const eqD = derive(() => {
      const g = gains.map(c => c.value);
      const N = 140;
      let d = "";
      for (let i = 0; i < N; i++) {
        const x = PX0 + (i / (N - 1)) * (PX1 - PX0);
        const f = Math.exp(LOGMIN + (i / (N - 1)) * (LOGMAX - LOGMIN));
        const y = dbToY(responseDb(f, g, BANDS, fs));
        d += i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      return d;
    });
    s(pathD(eqD, { stroke: ACCENT, strokeWidth: 2.5, cap: "round", join: "round" }));

    // ── draggable control points: drag → solve gains ──
    BANDS.forEach((b, j) => {
      const out = curve[`b${j}`]!;
      const bx = freqToX(b.freq);
      const handle = Vec.lens(
        [out] as const,
        ([db]) => ({ x: bx, y: dbToY(db) }),
        t => [yToDb(t.y)] as never,
      ) as Writable<Vec>;
      const dot = s(circle(handle, 7, { fill: ACCENT, stroke: ACCENT }));
      drag(dot, handle);
      dot.el.style.cursor = "ns-resize";
    });

    // ── play / pause ──
    const playing = cell(false);
    const by = H - 30;
    const btn = s(rect(vec(W / 2, by), 96, 30, { corner: 15, thin: true, stroke: tokens.stroke }));
    const btnLabel = s(label(vec(W / 2, by), derive(() => (playing.value ? "❚❚  pause" : "▶  play"))));
    const toggle = async (): Promise<void> => {
      await graph.resume();
      if (graph.playing) graph.pause();
      else graph.play();
      playing.value = graph.playing;
    };
    for (const el of [btn.el, btnLabel.el]) {
      el.style.cursor = "pointer";
      // The outline rect has no fill, so SVG won't hit-test its interior;
      // `all` captures clicks anywhere in the pill, not just on the glyphs.
      el.style.pointerEvents = "all";
      el.addEventListener("click", toggle);
    }

    // ── captions ──
    s(
      label(view.top.down(18), "drag the curve — the EQ solves the band gains that fit it", {
        size: 12,
        bold: true,
      }),
    );
    s(
      label(
        vec(W / 2, by - 26),
        "forward: gains → sound · backward: drag a point → factor solves gains",
        { size: 10, opacity: 0.7 },
      ),
    );
  }
}
