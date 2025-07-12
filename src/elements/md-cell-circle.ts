import { BaseElement, attr, css } from "./base-element";

interface CellState {
  filled: boolean;
  color?: string;
}

export class MdCellCircle extends BaseElement {
  @attr() cells?: string;
  @attr() size?: string;
  @attr() width?: string;

  private cellStates: Map<number, CellState> = new Map();

  static styles = css`
    :host {
      display: block;
      margin: 2rem 0;
      --circle-size: 300px;
      --circle-width: 0.3;
    }

    @media (max-width: 767px) {
      :host {
        margin: 0.5rem 0;
      }
    }

    .circle-container {
      font-family: "New CM", monospace;
      padding: 1rem;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    @media (max-width: 767px) {
      .circle-container {
        padding: 0.5rem;
      }
    }

    .circle-visualization {
      position: relative;
      width: var(--circle-size);
      height: var(--circle-size);
    }

    .circle-svg {
      width: 100%;
      height: 100%;
      overflow: visible;
    }

    .circle-sector {
      stroke: color-mix(in srgb, var(--text-color) 80%, transparent);
      stroke-width: 0.12rem;
    }

    .circle-center-text {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      font-family: "Recursive", monospace;
      font-variation-settings: "CASL" 1, "wght" 600;
      color: var(--text-color);
      font-size: 0.8em;
    }
  `;

  get cellCount(): number {
    return parseInt(this.cells || "4", 10);
  }

  // Programmatic interface for cells
  // Minimal programmatic interface
  setCell(index: number, color?: string): void {
    if (index < 0 || index >= this.cellCount) return;

    this.cellStates.set(index, {
      filled: true,
      color: color || "color-mix(in srgb, var(--text-color) 20%, transparent)",
    });

    this.render();
  }

  clearCell(index: number): void {
    if (index < 0 || index >= this.cellCount) return;

    this.cellStates.delete(index);
    this.render();
  }

  clearAll(): void {
    this.cellStates.clear();
    this.render();
  }

  getCellState(index: number): { filled: boolean; color?: string } {
    const state = this.cellStates.get(index);
    return { filled: state?.filled || false, color: state?.color };
  }

  private polarToCartesian(
    centerX: number,
    centerY: number,
    radius: number,
    angleInDegrees: number
  ): { x: number; y: number } {
    const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
    return {
      x: centerX + radius * Math.cos(angleInRadians),
      y: centerY + radius * Math.sin(angleInRadians),
    };
  }

  private createAnnularSector(
    centerX: number,
    centerY: number,
    innerRadius: number,
    outerRadius: number,
    startAngle: number,
    endAngle: number
  ): string {
    const startOuter = this.polarToCartesian(
      centerX,
      centerY,
      outerRadius,
      startAngle
    );
    const endOuter = this.polarToCartesian(
      centerX,
      centerY,
      outerRadius,
      endAngle
    );
    const startInner = this.polarToCartesian(
      centerX,
      centerY,
      innerRadius,
      endAngle
    );
    const endInner = this.polarToCartesian(
      centerX,
      centerY,
      innerRadius,
      startAngle
    );

    const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

    const pathData = [
      "M",
      startOuter.x,
      startOuter.y,
      "A",
      outerRadius,
      outerRadius,
      0,
      largeArcFlag,
      1,
      endOuter.x,
      endOuter.y,
      "L",
      startInner.x,
      startInner.y,
      "A",
      innerRadius,
      innerRadius,
      0,
      largeArcFlag,
      0,
      endInner.x,
      endInner.y,
      "Z",
    ].join(" ");

    return pathData;
  }

  protected render(): void {
    const numCells = this.cellCount;

    if (numCells <= 0) {
      this.shadow.innerHTML = `
        <div class="circle-container">
          <div>Invalid number of cells</div>
        </div>
      `;
      return;
    }

    const size = parseInt(this.size || "300", 10);
    const widthRatio = parseFloat(this.width || "0.3");

    // Merge programmatic state with attribute-based state
    const allFilled = new Map();

    // Programmatic state overrides attribute state
    for (const [index, state] of this.cellStates) {
      if (state.filled) {
        allFilled.set(
          index,
          state.color ||
            "color-mix(in srgb, var(--text-color) 20%, transparent)"
        );
      }
    }

    const centerX = size / 2;
    const centerY = size / 2;
    const outerRadius = size / 2;
    const innerRadius = outerRadius * (1 - widthRatio);

    const anglePerCell = 360 / numCells;
    let sectorsHtml = "";

    for (let i = 0; i < numCells; i++) {
      const startAngle = i * anglePerCell;
      const endAngle = (i + 1) * anglePerCell;

      const pathData = this.createAnnularSector(
        centerX,
        centerY,
        innerRadius,
        outerRadius,
        startAngle,
        endAngle
      );

      const fillColor = allFilled.get(i);
      const fillStyle = fillColor ? `fill="${fillColor}"` : 'fill="none"';

      sectorsHtml += `
        <path
          class="circle-sector"
          d="${pathData}"
          vector-effect="non-scaling-stroke"
          ${fillStyle}
          data-cell="${i + 1}"
        />
      `;
    }

    const containerStyle = this.size
      ? ` style="--circle-size: ${this.size}px"`
      : "";

    const centerText = this.textContent?.trim() || "";

    this.shadow.innerHTML = `
      <div class="circle-container"${containerStyle}>
        <div class="circle-visualization">
          <svg class="circle-svg" viewBox="0 0 ${size} ${size}">
            ${sectorsHtml}
          </svg>
          ${
            centerText
              ? `<div class="circle-center-text">${centerText}</div>`
              : ""
          }
        </div>
      </div>
    `;
  }
}
