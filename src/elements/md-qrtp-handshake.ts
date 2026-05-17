import { Diagram, Mount, arrow, attr, label, line, loop, vec, rect, cell, snapshot, split, t, when, type Cell } from "../minim";

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
const PAD_X = 40;
const PAD_Y = 8;

function initialChunks(prefix: string, n: number): ChunkState[] {
  return Array.from({ length: n }, (_, i) => ({
    data: `${prefix}${i + 1}`,
    ack: "",
    status: i === 0 ? "current" : "future",
  }));
}

export class MdQrtpHandshake extends Diagram {
  @attr.num(4) declare chunks: Cell<number>;

  protected scene(s: Mount): void {
    const N = this.chunks.value;
    const W = N * PITCH - CHUNK_GAP;
    const H = CHUNK_H * 2 + DEVICE_GAP;
    this.view(W + 50, H + 2 * PAD_Y);

    // Single source of truth — both rows + arrow visibility derive from
    // the chunk arrays. Arrows fire iff the corresponding chunk's `ack`
    // is set.
    const state = {
      A: cell(initialChunks("A", N)),
      B: cell(initialChunks("B", N)),
    };

    // Build one row of N chunks reading from `state[device]`. Returns
    // the [data, ack] bounds per chunk so arrows can land on them.
    const buildRow = (device: "A" | "B", y: number) =>
      Array.from({ length: N }, (_, i) => {
        const r = s(rect(i * PITCH + PAD_X, y + PAD_Y, CHUNK_W, CHUNK_H));
        const [data, ack] = split(r, "x", [3, 2]);
        s(
          line(data.at(1, 0), data.at(1, 1), { thin: true }),
          // Dashed outline around the "current" chunk only — concentric
          // outline keeps the corner radius matching the inner rect.
          r.outline(4, {
            dashed: true,
            cap: "round",
            opacity: when(() => state[device].value[i].status === "current"),
            aside: true,
          }),
          // Data slot: value (only when not future) + muted "data" tag.
          label(data.center.up(5), () => {
            const c = state[device].value[i];
            if (c.status === "future") return "";
            return t(t(c.data[0]).bold(), t(c.data.slice(1)).italic());
          }),
          label(data.center.down(8), t("data").muted(), { size: 12 }),
          // Ack slot: hash (when set) + muted "ack" tag.
          label(ack.center.up(5), () => state[device].value[i].ack),
          label(ack.center.down(8), t("ack").muted(), { size: 12 }),
        );

        return { data, ack };
      });

    const slotsA = buildRow("A", 0);
    const slotsB = buildRow("B", CHUNK_H + DEVICE_GAP);

    s(
      label(vec(PAD_X - 25, CHUNK_H / 2 + PAD_Y), t("A").bold(), { size: 18 }),
      label(
        vec(PAD_X - 25, CHUNK_H + DEVICE_GAP + CHUNK_H / 2 + PAD_Y),
        t("B").bold(),
        { size: 18 },
      ),
    );

    // 2N pre-built arrows (A→B and B→A per chunk index). Visibility
    // derives directly from the source chunk's `ack` — no separate
    // arrows array to keep in sync.
    for (let i = 0; i < N; i++) {
      s(
        arrow(slotsA[i].ack.bottom, slotsB[i].data.top, {
          opacity: when(() => state.A.value[i].ack !== ""),
        }),
        arrow(slotsB[i].ack.top, slotsA[i].data.bottom, {
          opacity: when(() => state.B.value[i].ack !== ""),
        }),
      );
    }

    // ── Mutation helpers ────────────────────────────────────────────

    const addAck = (device: "A" | "B", i: number, hash: string) => {
      const next = [...state[device].peek()];
      next[i] = { ...next[i], ack: hash };
      state[device].value = next;
    };

    const advance = (device: "A" | "B", i: number) => {
      const next = [...state[device].peek()];
      next[i] = { ...next[i], status: "past" };
      if (i + 1 < N) next[i + 1] = { ...next[i + 1], status: "current" };
      state[device].value = next;
    };

    // ── Animation ────────────────────────────────────────────────────

    const reset = snapshot(state);
    this.anim.start(loop(function* () {
      reset();
      for (let i = 0; i < N; i++) {
        const [first, second] = R.shuffle(["A", "B"] as const);

        yield R.float(0.5, 2.5);
        addAck(first, i, R.hex(3));

        yield R.float(0.3, 1.3);
        addAck(second, i, R.hex(3));
        advance(second, i);

        yield R.float(0.2, 0.7);
        advance(first, i);
      }

      yield 3;
    }));
  }
}
