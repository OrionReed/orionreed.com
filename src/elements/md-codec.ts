import { BaseElement, attr, css } from "./base-element";

interface CodecPart {
  label: string;
  unitSize: number;
  group?: string;
}

export class MdCodec extends BaseElement {
  @attr() width?: string;

  static styles = css`
    :host {
      display: block;
      margin: 2rem 0;
      --codec-border: 0.15rem solid
        color-mix(in srgb, var(--text-color) 80%, transparent);
      --codec-spacing: 0.3rem;
      --codec-height: 4rem;
    }

    .codec-container {
      font-family: "New CM", monospace;
      padding: 1rem;
      display: flex;
      justify-content: center;
    }

    .codec-visualization {
      position: relative;
      display: flex;
      margin-top: 3rem;
      width: 100%;
      max-width: var(--codec-width, 100%);
    }

    .codec-part,
    .codec-part-nested {
      position: relative;
      border: var(--codec-border);
      border-right: none;
      color: var(--text-color);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: "Recursive", monospace;
      font-variation-settings: "CASL" 1, "wght" 700;
      font-size: 1em;
    }

    .codec-part {
      height: var(--codec-height);
    }

    .codec-part:first-child,
    .codec-part-nested:first-child {
      border-top-left-radius: 4px;
      border-bottom-left-radius: 4px;
    }

    .codec-part:last-child,
    .codec-part-nested:last-child {
      border-right: var(--codec-border);
      border-top-right-radius: 4px;
      border-bottom-right-radius: 4px;
    }

    .codec-part-nested:first-child {
      border-radius: 2px 0 0 2px;
    }

    .codec-part-nested:last-child {
      border-radius: 0 2px 2px 0;
    }

    .codec-label {
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: rotate(-45deg);
      transform-origin: center left;
      white-space: nowrap;
      font-size: 0.8em;
      color: var(--text-color);
      margin-bottom: var(--codec-spacing);
    }

    .codec-nested-container {
      position: absolute;
      inset: var(--codec-spacing);
      display: flex;
    }
  `;

  private parseContent(): CodecPart[] {
    const lines = (this.textContent?.trim() || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.map((line) => {
      const colonIndex = line.indexOf(":");

      if (colonIndex === -1) {
        return { label: line, unitSize: 1 };
      }

      const label = line.slice(0, colonIndex).trim();
      const rest = line.slice(colonIndex + 1).trim();

      if (!rest) {
        return { label, unitSize: 1 };
      }

      // Parse "size group" or "group size" or just "size" or just "group"
      const match = rest.match(
        /^(?:(\d+)\s+([a-zA-Z])|([a-zA-Z])\s+(\d+)|(\d+)|([a-zA-Z]))$/
      );

      if (!match) {
        return { label, unitSize: 1 };
      }

      const [, size1, group1, group2, size2, sizeOnly, groupOnly] = match;
      const unitSize = parseInt(size1 || size2 || sizeOnly || "1", 10);
      const group = group1 || group2 || groupOnly || undefined;

      return { label, unitSize, group };
    });
  }

  private groupSegments(parts: CodecPart[]) {
    interface PartSegment {
      parts: CodecPart[];
      group?: string;
      totalUnits: number;
    }

    const segments: PartSegment[] = [];
    let currentSegment: PartSegment | null = null;

    for (const part of parts) {
      if (!currentSegment || currentSegment.group !== part.group) {
        currentSegment = {
          parts: [part],
          group: part.group,
          totalUnits: part.unitSize,
        };
        segments.push(currentSegment);
      } else {
        currentSegment.parts.push(part);
        currentSegment.totalUnits += part.unitSize;
      }
    }

    return segments;
  }

  private renderSegment(
    segment: { parts: CodecPart[]; group?: string; totalUnits: number },
    totalUnits: number
  ): string {
    const widthPercent = (segment.totalUnits / totalUnits) * 100;

    if (segment.group && segment.parts.length > 1) {
      const nestedHtml = segment.parts
        .map((part) => {
          const partWidth = (part.unitSize / segment.totalUnits) * 100;
          return `
            <div class="codec-part-nested" style="width: ${partWidth}%;">
              <div class="codec-label">${part.label}</div>
            </div>
          `;
        })
        .join("");

      return `
        <div class="codec-part" style="width: ${widthPercent}%;">
          <div class="codec-nested-container">${nestedHtml}</div>
        </div>
      `;
    }

    const part = segment.parts[0];
    return `
      <div class="codec-part" style="width: ${widthPercent}%;">
        <div class="codec-label">${part.label}</div>
      </div>
    `;
  }

  protected render(): void {
    const parts = this.parseContent();

    if (parts.length === 0) {
      this.shadow.innerHTML = `
        <div class="codec-container">
          <div>No codec parts defined</div>
        </div>
      `;
      return;
    }

    const totalUnits = parts.reduce((sum, p) => sum + p.unitSize, 0);
    const segments = this.groupSegments(parts);
    const segmentsHtml = segments
      .map((segment) => this.renderSegment(segment, totalUnits))
      .join("");

    const containerStyle = this.width
      ? ` style="--codec-width: ${this.width}"`
      : "";

    this.shadow.innerHTML = `
      <div class="codec-container"${containerStyle}>
        <div class="codec-visualization">${segmentsHtml}</div>
      </div>
    `;
  }
}
