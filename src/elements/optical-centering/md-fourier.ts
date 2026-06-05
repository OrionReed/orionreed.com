// md-fourier.ts — time ↔ frequency as a unitary change-of-basis lens.
//
// The canonical cell holds harmonic amplitudes `a₁..a_K`; the waveform is
// `coeffs.lens(synthesize, analyze)` — a perfectly invertible pair (a
// truncated sine transform and its inverse). Drag a harmonic bar →
// synthesis reshapes the wave; click a preset → the samples flow back
// through `analyze`, so the bars show the Fourier series (watch the square
// wave's Gibbs ringing). Both directions of one lens.

import {
  cell,
  circle,
  Diagram,
  derive,
  drag,
  label,
  line,
  type Mount,
  Num,
  pathD,
  rect,
  Vec,
  vec,
} from "../../minim";

const W = 660;
const H = 380;
const N = 128; // samples
const K = 16; // harmonics

const WAVE_X0 = 40;
const WAVE_X1 = 620;
const WAVE_CY = 110;
const WAVE_AMP = 80;

const SPEC_MID = 290;
const SPEC_SCALE = 55;

function synthesize(a: readonly number[]): number[] {
  const s = new Array<number>(N);
  for (let n = 0; n < N; n++) {
    let v = 0;
    for (let k = 0; k < K; k++) v += a[k]! * Math.sin((2 * Math.PI * (k + 1) * n) / N);
    s[n] = v;
  }
  return s;
}

function analyze(s: readonly number[]): number[] {
  const a = new Array<number>(K);
  for (let k = 0; k < K; k++) {
    let v = 0;
    for (let n = 0; n < N; n++) v += s[n]! * Math.sin((2 * Math.PI * (k + 1) * n) / N);
    a[k] = (2 / N) * v;
  }
  return a;
}

const PRESETS: Array<{ name: string; fn: (u: number) => number }> = [
  { name: "sine", fn: u => Math.sin(2 * Math.PI * u) },
  { name: "square", fn: u => (u < 0.5 ? 1 : -1) },
  { name: "saw", fn: u => 1 - 2 * u },
  { name: "triangle", fn: u => 1 - 2 * Math.abs(2 * u - 1) },
  { name: "clear", fn: () => 0 },
];

export class MdFourier extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    const init = new Array<number>(K).fill(0);
    init[0] = 1;
    // Canonical = harmonic amplitudes; the waveform is a lens onto it.
    const a = cell([...init]);
    const samples = a.lens(synthesize, sNew => analyze(sNew));

    // ─── Waveform ──────────────────────────────────────────────────
    s(line(vec(WAVE_X0, WAVE_CY), vec(WAVE_X1, WAVE_CY), { thin: true, opacity: 0.4 }));
    const waveD = () => {
      const sig = synthesize(a.value);
      let d = "";
      for (let n = 0; n < N; n++) {
        const x = WAVE_X0 + (n / (N - 1)) * (WAVE_X1 - WAVE_X0);
        const y = WAVE_CY - sig[n]! * WAVE_AMP;
        d += `${n === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)} `;
      }
      return d;
    };
    s(pathD(derive(waveD), { strokeWidth: 2.5 }));

    // ─── Spectrum bars ─────────────────────────────────────────────
    s(line(vec(WAVE_X0, SPEC_MID), vec(WAVE_X1, SPEC_MID), { thin: true, opacity: 0.4 }));
    const span = WAVE_X1 - 30 - (WAVE_X0 + 20);
    for (let k = 0; k < K; k++) {
      const bx = WAVE_X0 + 20 + ((k + 0.5) * span) / K;
      const color = derive(() => ((a.value[k] ?? 0) >= 0 ? "#5b8def" : "#e25c5c"));
      const topY = Num.derive(() => SPEC_MID - (a.value[k] ?? 0) * SPEC_SCALE);
      s(
        line(
          vec(bx, SPEC_MID),
          Vec.derive(() => ({ x: bx, y: topY.value })),
          {
            strokeWidth: Math.max(3, (span / K) * 0.45),
            stroke: color,
          },
        ),
      );
      const handle = Vec.lens(
        [a] as const,
        ([arr]) => ({ x: bx, y: SPEC_MID - (arr[k] ?? 0) * SPEC_SCALE }),
        t => {
          const b = [...a.value];
          b[k] = (SPEC_MID - t.y) / SPEC_SCALE;
          return [b] as never;
        },
      );
      const dot = s(circle(handle, 5, { fill: color, stroke: color }));
      drag(dot, handle);
      dot.el.style.cursor = "ns-resize";
      s(label(vec(bx, SPEC_MID + 18), `${k + 1}`, { size: 9, opacity: 0.6 }));
    }

    // ─── Preset buttons ────────────────────────────────────────────
    PRESETS.forEach((p, i) => {
      const cx = 70 + i * 90;
      const chip = s(rect(vec(cx, H - 28), 78, 26, { corner: 13, thin: true, stroke: "#888" }));
      const txt = s(label(vec(cx, H - 28), p.name, { size: 11 }));
      const apply = () => {
        samples.value = Array.from({ length: N }, (_, n) => p.fn((n + 0.5) / N));
      };
      for (const el of [chip.el, txt.el]) {
        el.style.cursor = "pointer";
        el.addEventListener("click", apply);
      }
    });

    s(
      label(view.top.down(18), "drag a bar → synthesis · pick a waveform → analysis", {
        size: 11,
        bold: true,
      }),
    );
    s(
      label(
        view.bottom.up(8),
        "waveform = coeffs.lens(synthesize, analyze) · a unitary, perfectly invertible change of basis",
        { size: 10 },
      ),
    );
  }
}
