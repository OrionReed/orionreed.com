import { BaseElement, attr, css } from "./base-element";

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

  private deviceA: DeviceState = {
    chunks: [],
  };

  private deviceB: DeviceState = {
    chunks: [],
  };

  private arrows: Arrow[] = [];
  private currentChunk = 0;

  static styles = css`
    :host {
      display: block;
      margin: 2rem 0;
      --chunk-width: 80px;
      --chunk-height: 50px;
      --diagram-width: 600px;
      --diagram-height: 280px;
    }

    .handshake-container {
      font-family: "New CM", monospace;
      padding: 1rem;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .handshake-visualization {
      position: relative;
      width: var(--diagram-width);
      height: var(--diagram-height);
    }

    .handshake-svg {
      width: 100%;
      height: 100%;
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

  private initializeDevices(): void {
    this.deviceA.chunks = [];
    this.deviceB.chunks = [];
    this.arrows = [];
    this.currentChunk = 0;

    // Both devices have data chunks
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

    this.render();

    // Wait a moment before starting the progression
    setTimeout(() => {
      this.startChunkCycle();
    }, 1500);
  }

  private startChunkCycle(): void {
    // Random device goes first
    const firstDevice = Math.random() < 0.5 ? "A" : "B";
    const secondDevice = firstDevice === "A" ? "B" : "A";

    // First device shows ACK after random delay
    setTimeout(() => {
      this.showFirstAck(firstDevice, secondDevice);
    }, Math.random() * 2000 + 500);
  }

  private showFirstAck(firstDevice: "A" | "B", secondDevice: "A" | "B"): void {
    const hash = this.generateHash();

    // Update first device's ACK
    if (firstDevice === "A") {
      this.deviceA.chunks[this.currentChunk].ack = hash;
    } else {
      this.deviceB.chunks[this.currentChunk].ack = hash;
    }

    // Create arrow from first device to second device's chunk
    this.arrows.push({
      fromDevice: firstDevice,
      toDevice: secondDevice,
      fromChunk: this.currentChunk,
      toChunk: this.currentChunk,
      hash: hash,
    });

    this.render();

    // Second device responds and advances
    setTimeout(() => {
      this.showSecondAckAndAdvance(firstDevice, secondDevice);
    }, Math.random() * 1000 + 300);
  }

  private showSecondAckAndAdvance(
    firstDevice: "A" | "B",
    secondDevice: "A" | "B"
  ): void {
    const hash = this.generateHash();

    // Update second device's ACK
    if (secondDevice === "A") {
      this.deviceA.chunks[this.currentChunk].ack = hash;
    } else {
      this.deviceB.chunks[this.currentChunk].ack = hash;
    }

    // Create arrow from second device to first device's chunk
    this.arrows.push({
      fromDevice: secondDevice,
      toDevice: firstDevice,
      fromChunk: this.currentChunk,
      toChunk: this.currentChunk,
      hash: hash,
    });

    // Second device advances immediately after showing ACK
    if (secondDevice === "A") {
      this.deviceA.chunks[this.currentChunk].status = "past";
      // Set next chunk as current for A if not at end
      if (this.currentChunk + 1 < this.totalChunks) {
        this.deviceA.chunks[this.currentChunk + 1].status = "current";
      }
    } else {
      this.deviceB.chunks[this.currentChunk].status = "past";
      // Set next chunk as current for B if not at end
      if (this.currentChunk + 1 < this.totalChunks) {
        this.deviceB.chunks[this.currentChunk + 1].status = "current";
      }
    }

    this.render();

    // First device sees second device's ACK and advances after delay
    setTimeout(() => {
      this.firstDeviceAdvance(firstDevice);
    }, Math.random() * 500 + 200);
  }

  private firstDeviceAdvance(firstDevice: "A" | "B"): void {
    // First device advances when it sees the second device's ACK
    if (firstDevice === "A") {
      this.deviceA.chunks[this.currentChunk].status = "past";
      // Set next chunk as current for A if not at end
      if (this.currentChunk + 1 < this.totalChunks) {
        this.deviceA.chunks[this.currentChunk + 1].status = "current";
      }
    } else {
      this.deviceB.chunks[this.currentChunk].status = "past";
      // Set next chunk as current for B if not at end
      if (this.currentChunk + 1 < this.totalChunks) {
        this.deviceB.chunks[this.currentChunk + 1].status = "current";
      }
    }

    // Move to next chunk
    this.currentChunk++;

    this.render();

    // Check if we're done, restart if so
    if (this.currentChunk >= this.totalChunks) {
      setTimeout(() => {
        this.initializeDevices();
      }, 3000);
    } else {
      // Continue with next chunk
      this.startChunkCycle();
    }
  }

  private startAnimation(): void {
    this.initializeDevices();
    this.render();
  }

  private stopAnimation(): void {
    // Animation is handled by timeouts, no interval to clear
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.startAnimation();
  }

  disconnectedCallback(): void {
    this.stopAnimation();
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
    const labelWidth = 40;
    const padding = 40;

    // Calculate positions (same as render method)
    const startX = padding + labelWidth;
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
    const labelWidth = 40;

    // Calculate total content width
    const totalContentWidth =
      labelWidth +
      this.totalChunks * (chunkWidth + chunkSpacing) -
      chunkSpacing;
    const contentHeight = 2 * chunkHeight + deviceSpacing;

    // Add padding around content
    const padding = 40;
    const viewBoxWidth = totalContentWidth + 2 * padding;
    const viewBoxHeight = contentHeight + 2 * padding;

    // Calculate positions (centered within viewBox)
    const startX = padding + labelWidth;
    const deviceAY = padding;
    const deviceBY = deviceAY + chunkHeight + deviceSpacing;
    const labelX = padding + labelWidth / 2;

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
