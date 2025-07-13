import { BaseElement, attr, css } from "./base-element";

interface NodeState {
  filled: boolean;
  color?: string;
}

interface EdgeState {
  visible: boolean;
  color?: string;
}

export class MdLubyTransform extends BaseElement {
  private edgeStates: Map<string, EdgeState> = new Map();
  private qrCellStates: boolean[] = []; // QR cell states
  private animationInterval?: number;

  static styles = css`
    :host {
      display: block;
      margin: 0rem 0;
      --node-size: 24px;
      --graph-width: 400px;
      --graph-height: 200px;
    }

    .graph-container {
      font-family: "New CM", monospace;
      padding: 1rem;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .graph-visualization {
      position: relative;
      width: var(--graph-width);
      height: var(--graph-height);
    }

    .qr-container {
      position: absolute;
      bottom: 28px;
      left: 50%;
      transform: translateX(-50%);
      width: 24px;
      height: 24px;
      border-radius: 2px;
      border: 1.5px solid var(--text-color);
      overflow: hidden;
      z-index: 10;
    }

    .qr-svg {
      width: 100%;
      height: 100%;
      background: transparent;
    }

    .qr-cell {
      fill: var(--text-color);
    }

    .graph-svg {
      width: 100%;
      height: 100%;
      overflow: visible;
    }

    .source-node {
      fill: none;
      stroke: var(--text-color);
      stroke-width: 1.5;
    }

    .xor-node {
      fill: none;
      stroke: var(--text-color);
      stroke-width: 1.5;
    }

    .source-label {
      font-family: "New CM", monospace;
      font-size: 16px;
      font-weight: bold;
      fill: var(--text-color);
      text-anchor: middle;
      dominant-baseline: central;
    }

    .dots-label {
      font-family: "New CM", monospace;
      font-size: 16px;
      fill: var(--text-color);
      text-anchor: middle;
      dominant-baseline: central;
    }

    .plus-line {
      stroke: var(--text-color);
      stroke-width: 1.5;
    }

    .edge {
      stroke: var(--text-color);
      stroke-width: 1.5;
      opacity: 0.7;
    }

    .edge.hidden {
      opacity: 0;
    }
  `;

  get topCount(): number {
    // Use 7 source symbols on small devices, 10 on larger devices
    return window.innerWidth < 768 ? 7 : 10;
  }

  get edgeCount(): number {
    return 5;
  }

  get qrGridSize(): number {
    return 5;
  }

  private sampleSolitonApprox(): number {
    // Approximate soliton distribution
    const rand = Math.random();

    if (rand < 0.1) return 1; // ~10% degree 1
    if (rand < 0.6) return 2; // ~50% degree 2
    if (rand < 0.75) return 3; // ~15% degree 3
    if (rand < 0.85) return 4; // ~10% degree 4
    if (rand < 0.92) return 5; // ~7% degree 5
    if (rand < 0.96) return 6; // ~4% degree 6
    if (rand < 0.98) return 7; // ~2% degree 7
    if (rand < 0.99) return 8; // ~1% degree 8
    if (rand < 0.995) return 9; // ~0.5% degree 9
    return 10; // ~0.5% degree 10
  }

  private randomizeQr(): void {
    const totalCells = this.qrGridSize * this.qrGridSize;
    this.qrCellStates = [];

    for (let i = 0; i < totalCells; i++) {
      // ~50% chance for each cell to be filled
      this.qrCellStates[i] = Math.random() < 0.5;
    }
  }

  private setRandomEdges(count: number): void {
    this.edgeStates.clear();

    if (count <= 0) return;

    const actualEdges = Math.min(count, this.topCount); // Only real source nodes

    // Generate random source indices (excluding dots node)
    const sourceIndices: number[] = [];
    for (let i = 0; i < this.topCount; i++) {
      sourceIndices.push(i);
    }

    // Shuffle the source indices
    for (let i = sourceIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sourceIndices[i], sourceIndices[j]] = [
        sourceIndices[j],
        sourceIndices[i],
      ];
    }

    // Take the first N source indices
    for (let i = 0; i < actualEdges; i++) {
      const sourceIndex = sourceIndices[i];
      const edgeKey = `source-${sourceIndex}`;
      this.edgeStates.set(edgeKey, { visible: true });
    }
  }

  private getSourceEdgeState(sourceIndex: number): EdgeState {
    const edgeKey = `source-${sourceIndex}`;
    return this.edgeStates.get(edgeKey) || { visible: false };
  }

  private getSourcePosition(
    index: number,
    total: number,
    width: number
  ): { x: number; y: number } {
    const spacing = total > 1 ? width / (total - 1) : width / 2;
    const x = total > 1 ? index * spacing : width / 2;
    return { x, y: 40 };
  }

  private getXorPosition(width: number): { x: number; y: number } {
    return { x: width / 2, y: 100 };
  }

  private getQrPosition(width: number): { x: number; y: number } {
    return { x: width / 2, y: 160 };
  }

  private getCircleEdgePoint(
    centerX: number,
    centerY: number,
    radius: number,
    fromX: number,
    fromY: number
  ): { x: number; y: number } {
    const dx = centerX - fromX;
    const dy = centerY - fromY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Unit vector pointing from center to source
    const unitX = dx / distance;
    const unitY = dy / distance;

    // Point on circle edge
    return {
      x: centerX - unitX * radius,
      y: centerY - unitY * radius,
    };
  }

  private startAnimation(): void {
    if (this.animationInterval) return; // Already running

    // Initial setup
    this.setRandomEdges(this.sampleSolitonApprox());
    this.randomizeQr();
    this.render();

    // Start animation loop
    this.animationInterval = window.setInterval(() => {
      // Sample edge count from soliton distribution
      const edgeCount = this.sampleSolitonApprox();
      this.setRandomEdges(edgeCount);

      // Also randomize the QR code
      this.randomizeQr();

      this.render();
    }, 500); // Update every second
  }

  private stopAnimation(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
      this.animationInterval = undefined;
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.startAnimation();
  }

  disconnectedCallback(): void {
    this.stopAnimation();
  }

  private renderQrCode(): string {
    if (this.qrCellStates.length === 0) return "";

    const gridSize = this.qrGridSize;
    const cellSize = 100 / gridSize; // Percentage size for each cell

    let cellsHtml = "";

    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const index = row * gridSize + col;
        const filled = this.qrCellStates[index];

        if (filled) {
          const x = col * cellSize;
          const y = row * cellSize;

          cellsHtml += `
            <rect 
              class="qr-cell"
              x="${x}%" 
              y="${y}%" 
              width="${cellSize}%" 
              height="${cellSize}%"
            />
          `;
        }
      }
    }

    return `
      <div class="qr-container">
        <svg class="qr-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          ${cellsHtml}
        </svg>
      </div>
    `;
  }

  protected render(): void {
    // Make width responsive based on number of symbols
    const isMobile = window.innerWidth < 768;
    const width = isMobile ? 300 : 400; // Slightly larger container on mobile for 7 nodes
    const height = 200;
    const sourceNodeSize = 32; // Even bigger source nodes
    const xorNodeSize = 24;
    const qrNodeSize = 24;

    const xorPos = this.getXorPosition(width - xorNodeSize);
    const qrPos = this.getQrPosition(width - qrNodeSize);

    // Generate source nodes with labels (centered, excluding dots)
    let sourceNodesHtml = "";

    // First generate the actual source nodes (centered)
    for (let i = 0; i < this.topCount; i++) {
      const pos = this.getSourcePosition(
        i,
        this.topCount,
        width - sourceNodeSize
      );

      sourceNodesHtml += `
        <rect class="source-node" 
              x="${pos.x}" y="${pos.y - sourceNodeSize / 2}" 
              width="${sourceNodeSize}" height="${sourceNodeSize}" 
              rx="2" />
        <text class="source-label" 
              x="${pos.x + sourceNodeSize / 2}" y="${pos.y}">
          S<tspan baseline-shift="sub" font-size="12px" font-style="italic">${
            i + 1
          }</tspan>
        </text>
      `;
    }

    // Add dots node to the right of the last source node
    if (this.topCount > 0) {
      const lastSourcePos = this.getSourcePosition(
        this.topCount - 1,
        this.topCount,
        width - sourceNodeSize
      );
      const dotsX = lastSourcePos.x + sourceNodeSize + 6; // 6px gap after last node

      sourceNodesHtml += `
        <text class="dots-label" 
              x="${dotsX + sourceNodeSize / 2}" y="${lastSourcePos.y}">
          ...
        </text>
      `;
    }

    // Generate XOR node with cross extending to circle edges
    const xorCenterX = xorPos.x + xorNodeSize / 2;
    const xorCenterY = xorPos.y;
    const crossSize = xorNodeSize / 2; // Extend to circle edges

    const xorNodeHtml = `
      <circle class="xor-node" 
              cx="${xorCenterX}" cy="${xorCenterY}" 
              r="${xorNodeSize / 2}" />
      <line class="plus-line"
            x1="${xorCenterX - crossSize}" y1="${xorCenterY}"
            x2="${xorCenterX + crossSize}" y2="${xorCenterY}" />
      <line class="plus-line"
            x1="${xorCenterX}" y1="${xorCenterY - crossSize}"
            x2="${xorCenterX}" y2="${xorCenterY + crossSize}" />
    `;

    // Generate edges from sources to XOR edge (only actual source nodes)
    let edgesHtml = "";
    for (let i = 0; i < this.topCount; i++) {
      const sourcePos = this.getSourcePosition(
        i,
        this.topCount,
        width - sourceNodeSize
      );
      const state = this.getSourceEdgeState(i);

      if (state.visible) {
        const sourceCenterX = sourcePos.x + sourceNodeSize / 2;
        const sourceCenterY = sourcePos.y + sourceNodeSize / 2;

        const edgePoint = this.getCircleEdgePoint(
          xorCenterX,
          xorCenterY,
          xorNodeSize / 2,
          sourceCenterX,
          sourceCenterY
        );

        const strokeStyle = state.color ? `stroke="${state.color}"` : "";

        edgesHtml += `
          <line class="edge" 
                x1="${sourceCenterX}" y1="${sourceCenterY}" 
                x2="${edgePoint.x}" y2="${edgePoint.y}" 
                ${strokeStyle} />
        `;
      }
    }

    // Edge from XOR to QR position (stop at QR border)
    const qrCenterX = qrPos.x + qrNodeSize / 2;
    const qrCenterY = qrPos.y;
    const qrEdgeY = qrPos.y - qrNodeSize / 2; // Top edge of QR container

    const qrEdgeHtml = `
      <line class="edge" 
            x1="${xorCenterX}" y1="${xorCenterY + xorNodeSize / 2}" 
            x2="${qrCenterX}" y2="${qrEdgeY}" />
    `;

    this.shadow.innerHTML = `
      <div class="graph-container">
        <div class="graph-visualization">
          <svg class="graph-svg" viewBox="0 0 ${width} ${height}">
            ${edgesHtml}
            ${qrEdgeHtml}
            ${sourceNodesHtml}
            ${xorNodeHtml}
          </svg>
          ${this.renderQrCode()}
        </div>
      </div>
    `;
  }

  static define(tagName: string = "md-luby-transform"): void {
    if (!customElements.get(tagName)) {
      customElements.define(tagName, this);
    }
  }
}
