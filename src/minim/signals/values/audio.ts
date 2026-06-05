// audio.ts — reactive audio clip (handle-as-value), the sound twin of canvas.ts.
//
// A Clip is context-free PCM: one Float32Array per channel plus a sample rate.
// The graph transports only the tiny header {pcm, sampleRate, epoch} and compares
// the monotonic epoch, so propagation never scans a sample and nothing is copied
// across the bus (same handle-as-value rule as Canvas, minus the GL context — PCM
// needs no ambient AudioContext, that only appears at the playback sink).
//
// Tiers mirror the rest of values/:
//   - pure isomorphisms (`reverse`) — one pass each way.
//   - reactive-param invertible (`gain(k)`) — reads `Val<number>`.
//   - complement projection (`normalize`) — the lossy view (peak-scaled) plus a
//     complement (the original peak) recovered on write-back, the audio analog of
//     str.lowercase()/canvas.grayscale().
//   - cross-type lens (`rms` → Num).

import { Cell, type Init, reader, type Val, type Writable } from "../signal";
import type { TraitDict } from "../traits";
import { Num } from "./num";

/** Clip header. The graph compares `epoch`; `pcm` is one channel buffer each. */
export interface AudioClip {
  readonly pcm: readonly Float32Array[];
  readonly sampleRate: number;
  readonly epoch: number;
}

type V = AudioClip;

let EPOCH = 0;
/** Stamp channel buffers with a fresh epoch — the only way to mint a value. */
export const stamp = (pcm: readonly Float32Array[], sampleRate: number): V => ({
  pcm,
  sampleRate,
  epoch: ++EPOCH,
});

export const equals = (a: V, b: V): boolean => a.epoch === b.epoch;

const peak = (v: V): number => {
  let m = 0;
  for (const ch of v.pcm) {
    for (let i = 0; i < ch.length; i++) {
      const a = ch[i]! < 0 ? -ch[i]! : ch[i]!;
      if (a > m) m = a;
    }
  }
  return m;
};

const rmsOf = (v: V): number => {
  let sum = 0;
  let n = 0;
  for (const ch of v.pcm) {
    for (let i = 0; i < ch.length; i++) sum += ch[i]! * ch[i]!;
    n += ch.length;
  }
  return n === 0 ? 0 : Math.sqrt(sum / n);
};

const scaled = (v: V, k: number): V =>
  stamp(
    v.pcm.map(ch => {
      const o = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) o[i] = ch[i]! * k;
      return o;
    }),
    v.sampleRate,
  );

export class Audio extends Cell<V> {
  static traits = { equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Audio.traits;

  constructor(v: V = { pcm: [], sampleRate: 44100, epoch: 0 }) {
    super(v, { equals });
  }

  // ── pure isomorphism ──────────────────────────────────────────────

  /** Time-reverse every channel. Involution. */
  reverse(): this {
    const run = (v: V) =>
      stamp(
        v.pcm.map(ch => {
          const o = new Float32Array(ch.length);
          for (let i = 0; i < ch.length; i++) o[i] = ch[ch.length - 1 - i]!;
          return o;
        }),
        v.sampleRate,
      );
    return this.lens(run, run);
  }

  // ── reactive-param invertible ─────────────────────────────────────

  /** Scalar gain. Invertible while k ≠ 0 — the audio twin of Canvas.brightness. */
  gain(k: Val<number>): this {
    const kf = reader(k);
    return this.lens(
      v => scaled(v, kf()),
      n => scaled(n, 1 / kf()),
    );
  }

  // ── complement projection ─────────────────────────────────────────

  /** Peak-normalize to reactive `target` (default 1). The view alone can't
   *  know the source's loudness, so the complement carries the original peak and
   *  the backward pass restores it. The audio analog of str.lowercase(). */
  normalize(target: Val<number> = 1): Writable<Audio> {
    const tf = reader(target);
    const self: Audio = this;
    return Audio.lens([self], {
      init: ([s]) => peak(s),
      step: ([s], c, external) => (external ? peak(s) : c),
      fwd: ([s]) => {
        const p = peak(s);
        return p === 0 ? s : scaled(s, tf() / p);
      },
      bwd: (view, _src, c) => {
        const t = tf();
        return { updates: [t === 0 ? view : scaled(view, c / t)], complement: c };
      },
    }) as Writable<Audio>;
  }

  // ── cross-type lens ───────────────────────────────────────────────

  /** RMS loudness as a writable `Num`; writing rescales the clip to hit it. */
  rms(): Writable<Num> {
    const self: Audio = this;
    return Num.lens(
      self,
      v => rmsOf(v),
      (target, v) => {
        const cur = rmsOf(v);
        return cur === 0 ? v : scaled(v, target / cur);
      },
    ) as Writable<Num>;
  }
}

/** Writable `Audio`. A `Clip` seeds a fresh cell; an existing `Writable<Audio>`
 *  passes through by identity. */
export function audio(v: Init<Audio>): Writable<Audio> {
  if (v instanceof Audio) return v as Writable<Audio>;
  return new Audio(v) as Writable<Audio>;
}
