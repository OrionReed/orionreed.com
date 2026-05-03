import { BaseElement, attr, css } from "./base-element";
import { Scene, t, type Shape } from "./draw";
import { pt } from "./geom";
import * as R from "./rand";

interface ChunkState {
  data: string;
  ack: string;
  status: "future" | "current" | "past";
}

interface DeviceState {
  chunks: ChunkState[];
}

interface Arrow {
  fromDevice: "A" | "B";
  toDevice: "A" | "B";
  fromChunk: number;
  toChunk: number;
  hash: string;
}

export class MdQrtpHandshake extends BaseElement {
  @attr({ type: "number" }) chunks?: number;
  @attr({ type: "number" }) speed?: number;

  private deviceA: DeviceState = { chunks: [] };
  private deviceB: DeviceState = { chunks: [] };
  private arrows: Arrow[] = [];

  static styles = css`
    :host {
      display: block;
      margin: 2rem 0;
    }

    .container {
      padding: 1rem;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .vis {
      width: 100%;
      max-width: 600px;
    }

    svg {
      width: 100%;
      height: auto;
      overflow: visible;
    }
  `;

  get totalChunks(): number {
    return this.chunks || 4;
  }

  get animationSpeed(): number {
    return this.speed || 800;
  }

  private initDevices(): void {
    this.deviceA.chunks = [];
    this.deviceB.chunks = [];
    this.arrows = [];

    for (let i = 0; i < this.totalChunks; i++) {
      this.deviceA.chunks.push({
        data: `A${i + 1}`,
        ack: "",
        status: i === 0 ? "current" : "future",
      });
      this.deviceB.chunks.push({
        data: `B${i + 1}`,
        ack: "",
        status: i === 0 ? "current" : "future",
      });
    }
  }

  private addAck(device: "A" | "B", other: "A" | "B", i: number): string {
    const hash = R.hex(3);
    const state = device === "A" ? this.deviceA : this.deviceB;
    state.chunks[i].ack = hash;
    this.arrows.push({
      fromDevice: device,
      toDevice: other,
      fromChunk: i,
      toChunk: i,
      hash,
    });
    return hash;
  }

  private advance(device: "A" | "B", i: number): void {
    const state = device === "A" ? this.deviceA : this.deviceB;
    state.chunks[i].status = "past";
    if (i + 1 < this.totalChunks) state.chunks[i + 1].status = "current";
  }

  connectedCallback(): void {
    super.connectedCallback();

    // Main protocol animation
    this.anim.loop(async () => {
      this.initDevices();
      this.render();

      for (let i = 0; i < this.totalChunks; i++) {
        const [first, second] = R.shuffle(["A", "B"] as const);

        await this.anim.wait(() => R.float(500, 2500));
        this.addAck(first, second, i);
        this.render();

        await this.anim.wait(() => R.float(300, 1300));
        this.addAck(second, first, i);
        this.advance(second, i);
        this.render();

        await this.anim.wait(() => R.float(200, 700));
        this.advance(first, i);
        this.render();
      }

      await this.anim.wait(3000);
    });
  }

  protected render(): void {
    if (!this.deviceA.chunks.length || !this.deviceB.chunks.length) {
      this.shadow.innerHTML = "";
      return;
    }

    const chunkW = 80;
    const chunkH = 50;
    const chunkGap = 15;
    const deviceGap = 130;
    const pitch = chunkW + chunkGap;
    const unitW = chunkW / 5;

    const isMobile = window.innerWidth < 768;
    const padding = isMobile ? 10 : 40;

    const rowAY = 0;
    const rowBY = chunkH + deviceGap;

    const s = new Scene({ padding });

    type SlotPair = {
      data: Shape;
      ack: Shape;
    };
    const slotsA: SlotPair[] = [];
    const slotsB: SlotPair[] = [];

    const drawChunk = (chunk: ChunkState, x: number, y: number): SlotPair => {
      // Each chunk is a 2-cell row (3 units data + 2 units ack = 60/40 split).
      // The row primitive handles the outer rounded boundary AND the inner
      // divider with butt caps automatically — no manual divider line.
      const chunkRow = s.row([{ units: 3 }, { units: 2 }], {
        x,
        y,
        h: chunkH,
        unitWidth: unitW,
      });
      const data = chunkRow.slot(0);
      const ack = chunkRow.slot(1);

      if (chunk.status === "current") {
        s.aside(s.outline(chunkRow, { offset: 4, cap: "round" }));
      }

      const dc = data.edge("center");
      const ac = ack.edge("center");

      if (chunk.status !== "future") {
        s.label(
          pt(dc.x, dc.y - 5),
          t(t(chunk.data[0]).bold(), t(chunk.data.slice(1)).italic()),
        );
      }
      s.label(pt(dc.x, dc.y + 8), t("data").muted(), { size: 12 });

      if (chunk.ack) s.label(pt(ac.x, ac.y - 5), chunk.ack);
      s.label(pt(ac.x, ac.y + 8), t("ack").muted(), { size: 12 });

      return { data, ack };
    };

    this.deviceA.chunks.forEach((c, i) =>
      slotsA.push(drawChunk(c, i * pitch, rowAY)),
    );
    this.deviceB.chunks.forEach((c, i) =>
      slotsB.push(drawChunk(c, i * pitch, rowBY)),
    );

    s.label(pt(-25, rowAY + chunkH / 2), t("A").bold(), { size: 18 });
    s.label(pt(-25, rowBY + chunkH / 2), t("B").bold(), { size: 18 });

    for (const arrow of this.arrows) {
      const fromSlots = arrow.fromDevice === "A" ? slotsA : slotsB;
      const toSlots = arrow.toDevice === "A" ? slotsA : slotsB;
      const fromAck = fromSlots[arrow.fromChunk].ack;
      const toData = toSlots[arrow.toChunk].data;
      const fromEdge = arrow.fromDevice === "A" ? "bottom" : "top";
      const toEdge = arrow.toDevice === "A" ? "bottom" : "top";
      s.arrow(fromAck.edge(fromEdge), toData.edge(toEdge));
    }

    this.shadow.innerHTML = `
      <div class="container">
        <div class="vis">
          <svg></svg>
        </div>
      </div>
    `;
    s.render(this.shadow.querySelector("svg") as SVGSVGElement);
  }
}
