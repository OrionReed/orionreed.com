import { BaseElement, attr, css } from "./base-element";
import { rand } from "./anim";

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
      --chunk-width: 80px;
      --chunk-height: 50px;
    }

    .handshake-container {
      font-family: "New CM", monospace;
      padding: 1rem;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .handshake-visualization {
      width: 100%;
      max-width: 600px;
    }

    .handshake-svg {
      width: 100%;
      height: auto;
      overflow: visible;
    }

    .device-label {
      font-family: "New CM", monospace;
      font-size: 18px;
      font-weight: bold;
      fill: var(--text-color);
      text-anchor: middle;
      dominant-baseline: central;
    }

    .chunk-box {
      fill: none;
      stroke: var(--text-color);
      stroke-width: 1.5;
    }

    .chunk-data {
      fill: none;
      stroke: var(--text-color);
      stroke-width: 1.5;
    }

    .chunk-ack {
      fill: none;
      stroke: var(--text-color);
      stroke-width: 1.5;
    }

    .chunk-outline {
      fill: none;
      stroke: var(--text-color);
      stroke-width: 1.5;
      stroke-dasharray: 3 3;
    }

    .chunk-label {
      font-family: "New CM", monospace;
      font-size: 14px;
      fill: var(--text-color);
      text-anchor: middle;
      dominant-baseline: central;
    }

    .section-label {
      font-family: "New CM", monospace;
      font-size: 12px;
      fill: var(--text-color);
      text-anchor: middle;
      dominant-baseline: central;
      opacity: 0.6;
    }

    .hash-arrow {
      stroke: var(--text-color);
      stroke-width: 1.5;
      fill: var(--text-color);
      opacity: 1;
      marker-end: url(#arrowhead);
    }
  `;

  get totalChunks(): number {
    return this.chunks || 4;
  }

  get animationSpeed(): number {
    return this.speed || 800;
  }

  private generateHash(): string {
    const chars = "abcdef0123456789";
    let hash = "";
    for (let i = 0; i < 3; i++) {
      hash += chars[Math.floor(Math.random() * chars.length)];
    }
    return hash;
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
    const hash = this.generateHash();
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
    this.anim.loop(async () => {
      this.initDevices();
      this.render();

      for (let i = 0; i < this.totalChunks; i++) {
        const first: "A" | "B" = Math.random() < 0.5 ? "A" : "B";
        const second: "A" | "B" = first === "A" ? "B" : "A";

        await this.anim.wait(() => rand(500, 2500));
        this.addAck(first, second, i);
        this.render();

        await this.anim.wait(() => rand(300, 1300));
        this.addAck(second, first, i);
        this.advance(second, i);
        this.render();

        await this.anim.wait(() => rand(200, 700));
        this.advance(first, i);
        this.render();
      }

      await this.anim.wait(3000);
    });
  }


  private renderChunkBox(chunk: ChunkState, x: number, y: number): string {
    const width = 80;
    const height = 50;
    const dataWidth = width * 0.6;
    const ackWidth = width * 0.4;

    const chunkClass = chunk.status;
    const dataClass = chunk.status;
    const ackClass = chunk.ack ? chunk.status : "future";

    const isCurrentChunk = chunk.status === "current";
    const outlineOffset = 4;

    return `
      ${
        isCurrentChunk
          ? `
      <!-- Current chunk outline -->
      <rect class="chunk-outline" 
            x="${x - outlineOffset}" y="${y - outlineOffset}" 
            width="${width + 2 * outlineOffset}" height="${
              height + 2 * outlineOffset
            }" rx="4" />
      `
          : ""
      }
      
      <!-- Chunk container -->
      <rect class="chunk-box ${chunkClass}" 
            x="${x}" y="${y}" 
            width="${width}" height="${height}" rx="2" />
      
      <!-- Data section -->
      <rect class="chunk-data ${dataClass}" 
            x="${x}" y="${y}" 
            width="${dataWidth}" height="${height}" rx="2" />
      
      <!-- Ack section -->
      <rect class="chunk-ack ${ackClass}" 
            x="${x + dataWidth}" y="${y}" 
            width="${ackWidth}" height="${height}" rx="2" />
      
      <!-- Labels -->
      ${
        chunk.status !== "future"
          ? `
      <text class="chunk-label ${chunkClass}" 
            x="${x + dataWidth / 2}" y="${y + height / 2 - 5}">
        <tspan font-weight="bold">${
          chunk.data[0]
        }</tspan><tspan font-style="italic">${chunk.data.slice(1)}</tspan>
      </text>
      `
          : ""
      }
      
      <text class="section-label" 
            x="${x + dataWidth / 2}" y="${y + height / 2 + 5}">
        data
      </text>
      
      ${
        chunk.ack
          ? `
        <text class="chunk-label ${ackClass}" 
              x="${x + dataWidth + ackWidth / 2}" y="${y + height / 2 - 5}">
          ${chunk.ack}
        </text>
      `
          : ""
      }
      
      <text class="section-label" 
            x="${x + dataWidth + ackWidth / 2}" y="${y + height / 2 + 5}">
        ack
      </text>
    `;
  }

  private renderArrows(): string {
    if (this.arrows.length === 0) return "";

    const chunkWidth = 80;
    const chunkHeight = 50;
    const chunkSpacing = 15;
    const deviceSpacing = 130;

    // Use same responsive padding as render method
    const isMobile = window.innerWidth < 768;
    const padding = isMobile ? 10 : 40;

    // Calculate positions (same as render method)
    const startX = padding;
    const deviceAY = padding;
    const deviceBY = deviceAY + chunkHeight + deviceSpacing;

    let arrowsHtml = "";

    // Render all arrows based on their stored positions
    for (const arrow of this.arrows) {
      const fromX = startX + arrow.fromChunk * (chunkWidth + chunkSpacing);
      const toX = startX + arrow.toChunk * (chunkWidth + chunkSpacing);

      let fromY, toY;

      if (arrow.fromDevice === "A" && arrow.toDevice === "B") {
        // A acknowledging B's data: from A's ACK section to B's data section
        fromY = deviceAY + chunkHeight; // Bottom of A's box (inner edge)
        toY = deviceBY; // Top of B's box (inner edge)
      } else {
        // B acknowledging A's data: from B's ACK section to A's data section
        fromY = deviceBY; // Top of B's box (inner edge)
        toY = deviceAY + chunkHeight; // Bottom of A's box (inner edge)
      }

      // Position arrow from ACK section of acknowledging device to data section of acknowledged chunk
      const ackSectionX = fromX + chunkWidth * 0.8; // Middle of ACK section (where the hash is)
      const dataSectionX = toX + chunkWidth * 0.3; // Middle of data section (what's being acknowledged)

      arrowsHtml += `<line class="hash-arrow" x1="${ackSectionX}" y1="${fromY}" x2="${dataSectionX}" y2="${toY}" />`;
    }

    return `
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="6" 
                refX="7" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="var(--text-color)" />
        </marker>
      </defs>
      ${arrowsHtml}
    `;
  }

  protected render(): void {
    // Guard against rendering before initialization
    if (!this.deviceA.chunks.length || !this.deviceB.chunks.length) {
      this.shadow.innerHTML = "";
      return;
    }

    const chunkWidth = 80;
    const chunkHeight = 50;
    const chunkSpacing = 15;
    const deviceSpacing = 130;

    // Calculate total content width (excluding labels so they don't affect centering)
    const totalContentWidth =
      this.totalChunks * (chunkWidth + chunkSpacing) - chunkSpacing;
    const contentHeight = 2 * chunkHeight + deviceSpacing;

    // Add padding around content - reduce padding on mobile
    const isMobile = window.innerWidth < 768;
    const padding = isMobile ? 10 : 40;
    const viewBoxWidth = totalContentWidth + 2 * padding;
    const viewBoxHeight = contentHeight + 2 * padding;

    // Calculate positions (chunks centered, labels positioned separately)
    const startX = padding;
    const deviceAY = padding;
    const deviceBY = deviceAY + chunkHeight + deviceSpacing;
    const labelX = startX - 25; // Position labels to the left of chunks

    let chunksHtml = "";

    // Render Device A chunks
    for (let i = 0; i < this.deviceA.chunks.length; i++) {
      const x = startX + i * (chunkWidth + chunkSpacing);
      chunksHtml += this.renderChunkBox(this.deviceA.chunks[i], x, deviceAY);
    }

    // Render Device B chunks
    for (let i = 0; i < this.deviceB.chunks.length; i++) {
      const x = startX + i * (chunkWidth + chunkSpacing);
      chunksHtml += this.renderChunkBox(this.deviceB.chunks[i], x, deviceBY);
    }

    this.shadow.innerHTML = `
      <div class="handshake-container">
        <div class="handshake-visualization">
          <svg class="handshake-svg" viewBox="0 0 ${viewBoxWidth} ${viewBoxHeight}">
            ${this.renderArrows()}
            
            <!-- Device labels -->
            <text class="device-label" x="${labelX}" y="${
              deviceAY + chunkHeight / 2
            }">A</text>
            <text class="device-label" x="${labelX}" y="${
              deviceBY + chunkHeight / 2
            }">B</text>
            
            <!-- Chunk boxes -->
            ${chunksHtml}
          </svg>
        </div>
      </div>
    `;
  }
}
