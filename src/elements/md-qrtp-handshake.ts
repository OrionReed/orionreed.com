import {
  Diagram,
  Scene,
  arrow,
  attr,
  label,
  line,
  pt,
  rect,
  signal,
  t,
  type Signal,
} from "../scene-v2";
import * as R from "./rand";

interface ChunkState {
  data: string;
  ack: string;
  status: "future" | "current" | "past";
}

const CHUNK_W = 80;
const CHUNK_H = 50;
const CHUNK_GAP = 15;
const DEVICE_GAP = 130;
const PITCH = CHUNK_W + CHUNK_GAP;

function initialChunks(prefix: string, n: number): ChunkState[] {
  return Array.from({ length: n }, (_, i) => ({
    data: `${prefix}${i + 1}`,
    ack: "",
    status: i === 0 ? "current" : "future",
  }));
}

export class MdQrtpHandshake extends Diagram {
  @attr({ type: "number" }) chunks?: number;

  protected setup(s: Scene): void {
    const N = this.chunks ?? 4;
    const W = N * PITCH - CHUNK_GAP;
    const H = CHUNK_H * 2 + DEVICE_GAP;
    s.view(-40, -8, W + 50, H + 16);

    const chunksA = signal<ChunkState[]>(initialChunks("A", N));
    const chunksB = signal<ChunkState[]>(initialChunks("B", N));
    const arrowsAB = signal<string[]>(new Array(N).fill(""));
    const arrowsBA = signal<string[]>(new Array(N).fill(""));

    // Build one row of N chunks reading from `state`. Returns the
    // [data, ack] bounds per chunk so arrows can land on them.
    const buildRow = (state: Signal<ChunkState[]>, y: number) =>
      Array.from({ length: N }, (_, i) => {
        const x = i * PITCH;
        const r = s(rect(x, y, CHUNK_W, CHUNK_H));
        const [data, ack] = r.bounds.split("x", [3, 2]);
        s(line(data.tr, data.br, { thin: true }));

        // Dashed outline around the "current" chunk only — concentric
        // outline keeps the corner radius matching the inner rect.
        s(r.outline(4, {
          dashed: true,
          cap: "round",
          opacity: () => state.value[i].status === "current" ? 1 : 0,
          aside: true,
        }));

        // Data slot: value (only when not future) + muted "data" tag below.
        s(label(data.center.up(5), () => {
          const c = state.value[i];
          if (c.status === "future") return "";
          return t(t(c.data[0]).bold(), t(c.data.slice(1)).italic());
        }));
        s(label(data.center.down(8), t("data").muted(), { size: 12 }));

        // Ack slot: hash (when set) + muted "ack" tag below.
        s(label(ack.center.up(5), () => state.value[i].ack));
        s(label(ack.center.down(8), t("ack").muted(), { size: 12 }));

        return { data, ack };
      });

    const slotsA = buildRow(chunksA, 0);
    const slotsB = buildRow(chunksB, CHUNK_H + DEVICE_GAP);

    s(label(pt(-25, CHUNK_H / 2), t("A").bold(), { size: 18 }));
    s(label(pt(-25, CHUNK_H + DEVICE_GAP + CHUNK_H / 2), t("B").bold(), { size: 18 }));

    // 2N pre-built arrows (A→B and B→A per chunk index), gated by
    // whether that ack has been sent.
    for (let i = 0; i < N; i++) {
      s(arrow(slotsA[i].ack.bottom, slotsB[i].data.top, {
        opacity: () => arrowsAB.value[i] ? 1 : 0,
      }));
      s(arrow(slotsB[i].ack.top, slotsA[i].data.bottom, {
        opacity: () => arrowsBA.value[i] ? 1 : 0,
      }));
    }

    // ── Mutation helpers ────────────────────────────────────────────

    const addAck = (device: "A" | "B", i: number, hash: string) => {
      const sig = device === "A" ? chunksA : chunksB;
      const arrSig = device === "A" ? arrowsAB : arrowsBA;
      const next = [...sig.value];
      next[i] = { ...next[i], ack: hash };
      sig.value = next;
      const a = [...arrSig.value];
      a[i] = hash;
      arrSig.value = a;
    };

    const advance = (device: "A" | "B", i: number) => {
      const sig = device === "A" ? chunksA : chunksB;
      const next = [...sig.value];
      next[i] = { ...next[i], status: "past" };
      if (i + 1 < N) next[i + 1] = { ...next[i + 1], status: "current" };
      sig.value = next;
    };

    // ── Animation ────────────────────────────────────────────────────

    this.anim.loop(function* () {
      // Reset for each cycle.
      chunksA.value = initialChunks("A", N);
      chunksB.value = initialChunks("B", N);
      arrowsAB.value = new Array(N).fill("");
      arrowsBA.value = new Array(N).fill("");

      for (let i = 0; i < N; i++) {
        const [first, second] = R.shuffle(["A", "B"] as const);

        yield R.float(500, 2500);
        addAck(first, i, R.hex(3));

        yield R.float(300, 1300);
        addAck(second, i, R.hex(3));
        advance(second, i);

        yield R.float(200, 700);
        advance(first, i);
      }

      yield 3000;
    });
  }
}
