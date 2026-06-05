// eq-audio.ts — the data plane for the bireactive EQ demo.
//
// Native WebAudio only (no worklet): a synthesized chord loop streams through
// a cascade of peaking BiquadFilters into an AnalyserNode. The reactive graph
// owns the control plane — it pushes solved gains onto `setGain` and reads the
// live spectrum via `spectrum`. `responseDb` is the closed-form model the
// inverse solve factors over; it matches the BiquadFilter cascade exactly
// (cascaded magnitudes multiply ⇒ dB add), so the drawn curve and the measured
// curve agree.

/** One peaking band: center frequency (Hz) + quality factor. Gain is a
 *  reactive control, not stored here. */
export interface EqBand {
  freq: number;
  q: number;
}

/** Magnitude (dB) of one RBJ peaking biquad at frequency `f`. Identical to
 *  WebAudio's `BiquadFilterNode` "peaking" math. */
export function peakingDb(f: number, f0: number, gainDb: number, q: number, fs: number): number {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);

  const b0 = 1 + alpha * A;
  const b1 = -2 * cw0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cw0;
  const a2 = 1 - alpha / A;

  const w = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const sw = Math.sin(w);
  const s2w = Math.sin(2 * w);

  const numRe = b0 + b1 * cw + b2 * c2w;
  const numIm = -(b1 * sw + b2 * s2w);
  const denRe = a0 + a1 * cw + a2 * c2w;
  const denIm = -(a1 * sw + a2 * s2w);

  const mag2 = (numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm);
  return 10 * Math.log10(mag2);
}

/** Summed response (dB) of the whole band cascade at frequency `f`. The
 *  function the inverse-EQ `factor` lens inverts. */
export function responseDb(f: number, gains: readonly number[], bands: readonly EqBand[], fs: number): number {
  let db = 0;
  for (let k = 0; k < bands.length; k++) db += peakingDb(f, bands[k]!.freq, gains[k]!, bands[k]!.q, fs);
  return db;
}

/** Render a seamless looping chord pad into a mono buffer. Additive saw-ish
 *  partials over a few notes — broadband (so EQ is audible) and musical. Note
 *  frequencies are snapped to whole cycles per buffer so the loop is click-free. */
function renderChord(ctx: AudioContext, seconds: number): AudioBuffer {
  const fs = ctx.sampleRate;
  const n = Math.floor(seconds * fs);
  const buf = ctx.createBuffer(1, n, fs);
  const d = buf.getChannelData(0);
  // A2 · E3 · A3 · E4, each snapped to integer cycles per buffer (seamless loop).
  const notes = [110, 164.81, 220, 329.63].map(f => Math.round(f * seconds) / seconds);
  for (const f0 of notes) {
    const K = Math.min(40, Math.floor(8000 / f0));
    for (let k = 1; k <= K; k++) {
      const amp = 0.6 / k / notes.length;
      const w = (2 * Math.PI * k * f0) / fs;
      for (let i = 0; i < n; i++) d[i]! += amp * Math.sin(w * i);
    }
  }
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(d[i]!);
    if (a > max) max = a;
  }
  const g = max > 0 ? 0.9 / max : 1;
  for (let i = 0; i < n; i++) d[i]! *= g;
  return buf;
}

/** Live native-WebAudio EQ graph: source → peaking cascade → master →
 *  analyser → destination. The reactive layer drives `setGain` and reads
 *  `spectrum`; this object never touches the reactive graph itself. */
export class AudioEqGraph {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly filters: BiquadFilterNode[];
  private readonly buffer: AudioBuffer;
  private source: AudioBufferSourceNode | null = null;
  playing = false;

  constructor(bands: readonly EqBand[]) {
    // biome-ignore lint/suspicious/noExplicitAny: webkit-prefixed fallback
    const Ctx: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
    this.ctx = new Ctx();
    this.buffer = renderChord(this.ctx, 3);

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.6;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;

    this.filters = bands.map(b => {
      const f = this.ctx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = b.freq;
      f.Q.value = b.q;
      f.gain.value = 0;
      return f;
    });
    for (let i = 0; i < this.filters.length - 1; i++) this.filters[i]!.connect(this.filters[i + 1]!);
    this.filters[this.filters.length - 1]!.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  /** Push a solved band gain (dB) onto the live filter (smoothed). */
  setGain(i: number, db: number): void {
    this.filters[i]?.gain.setTargetAtTime(db, this.ctx.currentTime, 0.02);
  }

  get binCount(): number {
    return this.analyser.frequencyBinCount;
  }
  freqForBin(i: number): number {
    return (i * this.ctx.sampleRate) / this.analyser.fftSize;
  }
  /** Fill `out` (length `binCount`) with the live magnitude spectrum (dB). */
  spectrum(out: Float32Array<ArrayBuffer>): void {
    this.analyser.getFloatFrequencyData(out);
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }
  play(): void {
    if (this.playing) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.loop = true;
    s.connect(this.filters[0]!);
    s.start();
    this.source = s;
    this.playing = true;
  }
  pause(): void {
    if (!this.playing) return;
    try {
      this.source?.stop();
      this.source?.disconnect();
    } catch {
      /* already stopped */
    }
    this.source = null;
    this.playing = false;
  }
  dispose(): void {
    try {
      this.pause();
    } catch {
      /* ok */
    }
    try {
      void this.ctx.close();
    } catch {
      /* ok */
    }
  }
}
