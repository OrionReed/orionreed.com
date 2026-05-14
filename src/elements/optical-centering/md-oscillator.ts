// Damped oscillator: x(t) = Ae^{-γt}cos(ωt)
//
// Three markers (A, γ, ω) bind the formula parts, diagram shapes, and
// prose elements into one shared identity per term.
//
// Hover γ (damping)   — decay envelope fades in while held, fades back out
//                        on release.
// Hover A (amplitude) — amplitude bound lines brighten.
// Hover ω (frequency) — period tick marks appear, scrolling left to show
//                        the cycle spacing.
//
// All generator code (`untilTrue`, `endOn`, `oscillate`) composes with
// marker signals the same way it does with any other signal, because
// `marker.active` is just a ReadonlyCell<boolean>.

import {
  Diagram,
  Mount,
  Shape,
  cell,
  play,
  circle,
  derive,
  drive,
  line,
  loop,
  oscillate,
  vec,
  tokens,
  not,
} from "../../minim";
import { parts, tex, bindParts } from "../../minim/tex";

// ── Constants ─────────────────────────────────────────────────────────────────

const TL = 42, TR = 558, TW = TR - TL;
const CY = 148;
const A_AMP  = 52;
const GAMMA  = 0.3;
const OMEGA  = 5.0;
const PERIOD = (2 * Math.PI) / OMEGA;
const T_LOOP = 8;
const WINDOW = 5;
const N      = 130;

// ── Markers — module-level so <md-marker sym="osc:*"> resolves before ─────────
// any element connects, regardless of DOM order.

const { A, gamma, omega } = parts({ A: "A", gamma: "\\gamma", omega: "\\omega" });
[A, gamma, omega].forEach((p, i) => {
  p.color.value = `oklch(0.65 0.15 ${((i / 3) * 360).toFixed(1)})`;
});
A.register("osc:A");
gamma.register("osc:gamma");
omega.register("osc:omega");

// ── Path helpers ──────────────────────────────────────────────────────────────

const yAt = (T: number) =>
  CY - A_AMP * Math.exp(-GAMMA * T) * Math.cos(OMEGA * T);

const computeTrace = (T: number): string => {
  let d = "";
  for (let i = 0; i <= N; i++) {
    const x = TL + (i / N) * TW;
    const pastT = T - WINDOW * (1 - i / N);
    const y = pastT >= 0 ? yAt(pastT) : CY;
    d += d ? ` L ${x.toFixed(1)} ${y.toFixed(1)}` : `M ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
};

const computeEnvelope = (T: number): string => {
  let top = "", bot = "";
  for (let i = 0; i <= N; i++) {
    const x = TL + (i / N) * TW;
    const pastT = Math.max(0, T - WINDOW * (1 - i / N));
    const e = A_AMP * Math.exp(-GAMMA * pastT);
    const yt = CY - e, yb = CY + e;
    top += top ? ` L ${x.toFixed(1)} ${yt.toFixed(1)}` : `M ${x.toFixed(1)} ${yt.toFixed(1)}`;
    bot += bot ? ` L ${x.toFixed(1)} ${yb.toFixed(1)}` : `M ${x.toFixed(1)} ${yb.toFixed(1)}`;
  }
  return `${top} ${bot}`;
};

// Vertical tick marks at each period boundary within the trace window.
// These slide left as time progresses, making the cycle rhythm visible.
const computeTicks = (T: number): string => {
  let d = "";
  for (let n = 0; n < 8; n++) {
    const tTick = T - n * PERIOD;
    if (tTick < 0) continue;
    const x = TR - (T - tTick) * (TW / WINDOW);
    if (x < TL || x > TR + 1) continue;
    const xf = x.toFixed(1);
    d += `M ${xf} ${(CY - A_AMP - 6).toFixed(1)} L ${xf} ${(CY + A_AMP + 6).toFixed(1)} `;
  }
  return d;
};

// ── Path shape factory ────────────────────────────────────────────────────────

function makePath(d: ReturnType<typeof cell.derived<string>>): Shape {
  const s = new Shape("path", () => ({ x: TL, y: CY - A_AMP - 12, w: TW, h: (A_AMP + 12) * 2 }));
  s.attr("fill", "none");
  s.attr("stroke-linecap", "round");
  s.attr("stroke-linejoin", "round");
  s.attr("d", d);
  return s;
}

// ── Diagram ───────────────────────────────────────────────────────────────────

export class MdOscillator extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 208);

    // ── Physics ───────────────────────────────────────────────────────────────
    const t = cell(0);
    this.anim.run(drive((dt) => { t.value = (t.value + dt) % T_LOOP; }));

    const disp = cell.derived(() =>
      A_AMP * Math.exp(-GAMMA * t.value) * Math.cos(OMEGA * t.value),
    );

    // ── Formula ───────────────────────────────────────────────────────────────
    const eq = s(tex`x(t) = ${A.with("A")} e^{-${gamma.with("\\gamma")}t}\cos(${omega.with("\\omega")}t)`);
    eq.center.set(view.top.down(22));
    this.root.track(bindParts(eq, { A, gamma, omega }));

    // ── Centerline ────────────────────────────────────────────────────────────
    const cl = s(line(vec(TL, CY), vec(TR, CY)));
    cl.attr("stroke", tokens.stroke);
    cl.attr("stroke-width", "0.5");
    cl.opacity.value = 0.12;

    // ── Oscillation trace ─────────────────────────────────────────────────────
    const trace = s(makePath(cell.derived(() => computeTrace(t.value))));
    trace.attr("stroke", tokens.stroke);
    trace.attr("stroke-width", "1.5");

    // ── Ball ─────────────────────────────────────────────────────────────────
    const ball = s(circle(vec(TR, cell.derived(() => CY - disp.value)), 5.5, { fill: true }));
    ball.attr("fill", cell.derived(() => A.color.value ?? tokens.stroke));

    // ── Amplitude bound lines (A) ─────────────────────────────────────────────
    const ampStroke = cell.derived(() => A.color.value ?? tokens.stroke);
    const ampOpacity = derive(A.active, (on) => (on ? 0.7 : 0.18));
    [CY - A_AMP, CY + A_AMP].forEach((y) => {
      const l = s(line(vec(TL, y), vec(TR, y), { stroke: ampStroke, opacity: ampOpacity }));
      l.attr("stroke-dasharray", "3 5");
    });

    // ── Period tick marks (ω) ─────────────────────────────────────────────────
    // Vertical dashed lines at each cycle boundary, sliding left as time
    // progresses. Their spacing IS the period — seeing them scroll shows ω.
    const tickPath = s(makePath(cell.derived(() => computeTicks(t.value))));
    tickPath.attr("stroke", cell.derived(() => omega.color.value ?? tokens.stroke));
    tickPath.attr("stroke-dasharray", "2 3");
    tickPath.attr("stroke-width", "1");
    tickPath.opacity.value = 0;

    this.anim.run(loop(function* () {
      yield* play(omega.active);
      yield* tickPath.opacity.to(0.65, 0.25);
      yield* play(not(omega.active));
      yield* tickPath.opacity.to(0, 0.3);
    }));

    // ── Decay envelope (γ) ────────────────────────────────────────────────────
    // Fades in on hover, pulses while held, fades back out on release.
    const envPath = s(makePath(cell.derived(() => computeEnvelope(t.value))));
    envPath.attr("stroke", cell.derived(() => gamma.color.value ?? tokens.stroke));
    envPath.attr("stroke-dasharray", "4 6");
    envPath.attr("stroke-width", "1");
    envPath.opacity.value = 0;

    this.anim.run(loop(function* () {
      yield* play(gamma.active);
      yield* envPath.opacity.to(0.85, 0.3);                         // fade in
      yield* play(oscillate(envPath.opacity, 0.1, 1.6)).while(gamma.active);
      yield* envPath.opacity.to(0, 0.4);                             // fade out
    }));

  }
}
