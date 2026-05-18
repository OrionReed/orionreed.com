// Damped oscillator x(t) = Ae^{-γt}cos(ωt); A/γ/ω markers cross-reference formula, diagram, prose.

import {Diagram, Mount, Shape, signal, play, circle, computed, drive, wave, line, loop, not, vec, tokens, Num, type Read} from "../../minim";

/** Sine oscillation around `sig`'s start value. */
const oscillate = (sig: Num, amp: number, freq: number) =>
  wave(sig, (t, base) => base + amp * Math.sin(2 * Math.PI * freq * t));
import {parts, tex, bindParts} from "../../minim/tex";

const TL = 42, TR = 558, TW = TR - TL;
const CY = 148;
const A_AMP  = 52;
const GAMMA  = 0.3;
const OMEGA  = 5.0;
const PERIOD = (2 * Math.PI) / OMEGA;
const T_LOOP = 8;
const WINDOW = 5;
const N      = 130;

// Markers at module scope so <md-marker sym="osc:*"> resolves before any element connects.
const { A, gamma, omega } = parts({ A: "A", gamma: "\\gamma", omega: "\\omega" });
[A, gamma, omega].forEach((p, i) => {
  p.color.value = `oklch(0.65 0.15 ${((i / 3) * 360).toFixed(1)})`;
});
A.register("osc:A");
gamma.register("osc:gamma");
omega.register("osc:omega");

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

function makePath(d: Read<string>): Shape {
  const s = new Shape("path", () => ({ x: TL, y: CY - A_AMP - 12, w: TW, h: (A_AMP + 12) * 2 }));
  s.attr("fill", "none");
  s.attr("stroke-linecap", "round");
  s.attr("stroke-linejoin", "round");
  s.attr("d", d);
  return s;
}

export class MdOscillator extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 208);

    const t = signal(0);
    this.anim.start(drive((dt) => { t.value = (t.value + dt) % T_LOOP; }));

    const disp = computed(() =>
      A_AMP * Math.exp(-GAMMA * t.value) * Math.cos(OMEGA * t.value),
    );

    const eq = s(tex`x(t) = ${A.with("A")} e^{-${gamma.with("\\gamma")}t}\cos(${omega.with("\\omega")}t)`);
    eq.center.set(view.top.down(22));
    this.root.track(bindParts(eq, { A, gamma, omega }));

    const cl = s(line(vec(TL, CY), vec(TR, CY)));
    cl.attr("stroke", tokens.stroke);
    cl.attr("stroke-width", "0.5");
    cl.opacity.value = 0.12;

    const trace = s(makePath(computed(() => computeTrace(t.value))));
    trace.attr("stroke", tokens.stroke);
    trace.attr("stroke-width", "1.5");

    const ball = s(circle(vec(TR, computed(() => CY - disp.value)), 5.5, { fill: true }));
    ball.attr("fill", computed(() => A.color.value ?? tokens.stroke));

    const ampStroke = computed(() => A.color.value ?? tokens.stroke);
    const ampOpacity = computed(() => ((on) => (on ? 0.7 : 0.18))(A.active.value));
    [CY - A_AMP, CY + A_AMP].forEach((y) => {
      const l = s(line(vec(TL, y), vec(TR, y), { stroke: ampStroke, opacity: ampOpacity }));
      l.attr("stroke-dasharray", "3 5");
    });

    const tickPath = s(makePath(computed(() => computeTicks(t.value))));
    tickPath.attr("stroke", computed(() => omega.color.value ?? tokens.stroke));
    tickPath.attr("stroke-dasharray", "2 3");
    tickPath.attr("stroke-width", "1");
    tickPath.opacity.value = 0;

    this.anim.start(loop(function* () {
      yield* play(omega.active);
      yield* tickPath.opacity.to(0.65, 0.25);
      yield* play(not(omega.active));
      yield* tickPath.opacity.to(0, 0.3);
    }));

    const envPath = s(makePath(computed(() => computeEnvelope(t.value))));
    envPath.attr("stroke", computed(() => gamma.color.value ?? tokens.stroke));
    envPath.attr("stroke-dasharray", "4 6");
    envPath.attr("stroke-width", "1");
    envPath.opacity.value = 0;

    this.anim.start(loop(function* () {
      yield* play(gamma.active);
      yield* envPath.opacity.to(0.85, 0.3);
      yield* play(oscillate(envPath.opacity, 0.1, 1.6)).until(not(gamma.active));
      yield* envPath.opacity.to(0, 0.4);
    }));

  }
}
