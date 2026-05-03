import { BaseElement, attr, css } from "./base-element";
import { Scene, t, type RowItem } from "./draw";
import { pt } from "./geom";

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
      margin: 1rem 0;
    }

    .container {
      padding: 1rem;
      display: flex;
      justify-content: center;
    }

    .vis {
      width: 100%;
      max-width: var(--codec-width, 100%);
    }

    svg {
      display: block;
      width: 100%;
      height: auto;
      overflow: visible;
    }
  `;

  private parseContent(): CodecPart[] {
    const lines = (this.textContent?.trim() || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.map((line) => {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) return { label: line, unitSize: 1 };

      const label = line.slice(0, colonIndex).trim();
      const rest = line.slice(colonIndex + 1).trim();
      if (!rest) return { label, unitSize: 1 };

      const match = rest.match(
        /^(?:(\d+)\s+([a-zA-Z])|([a-zA-Z])\s+(\d+)|(\d+)|([a-zA-Z]))$/
      );
      if (!match) return { label, unitSize: 1 };

      const [, size1, group1, group2, size2, sizeOnly, groupOnly] = match;
      const unitSize = parseInt(size1 || size2 || sizeOnly || "1", 10);
      const group = group1 || group2 || groupOnly || undefined;
      return { label, unitSize, group };
    });
  }

  protected render(): void {
    const parts = this.parseContent();

    if (parts.length === 0) {
      this.shadow.innerHTML = `<div class="container">No codec parts</div>`;
      return;
    }

    const totalUnits = parts.reduce((sum, p) => sum + p.unitSize, 0);

    // Scene units roughly match CSS pixels.
    const totalW = 400;
    const cellH = 64;
    const labelSize = 18;
    // Leader geometry: vertical leg above the row, then 45° diagonal
    // up-right that continues seamlessly into the rotated label.
    const vertH = 8;
    const diagD = 14;

    // Top padding accommodates: leader (vertH + diagD) + rotated label
    // height (~length × char_width / sqrt(2)).
    const longestLabel = parts.reduce(
      (m, p) => Math.max(m, p.label.length),
      0
    );
    const labelPad =
      vertH + diagD + Math.ceil(longestLabel * labelSize * 0.55 * 0.71) + 12;
    const s = new Scene({
      padding: { top: labelPad, bottom: 4, left: 4, right: 4 },
    });

    // Each part is a slot. The divider after a part is dashed when the
    // next part shares its group (= a "soft" subdivision), and solid
    // otherwise (= a "hard" boundary between unrelated regions).
    const items = parts.map((p, i): RowItem => {
      const next = parts[i + 1];
      const sameGroup = next && p.group !== undefined && p.group === next.group;
      return {
        units: p.unitSize,
        divider: sameGroup ? "dashed" : "solid",
      };
    });

    const row = s.row(items, {
      x: 0,
      y: 0,
      h: cellH,
      unitWidth: totalW / totalUnits,
    });

    const bendY = row.bounds.y - vertH;
    const labelOffsetY = bendY - diagD;

    // Approximate label width in user units; if it fits comfortably
    // inside a cell, render the label INSIDE (centered, not rotated).
    // Otherwise use the leader-line + rotated-label pattern above.
    const charWidth = labelSize * 0.55;

    parts.forEach((part, i) => {
      const slot = row.slot(i);
      const cellCx = slot.edge("center").x;
      const cellCy = slot.edge("center").y;
      const cellTopY = slot.bounds.y;
      const labelW = part.label.length * charWidth;
      const fitsInside = labelW + 16 < slot.bounds.w;

      if (fitsInside) {
        s.label(pt(cellCx, cellCy), t(part.label).bold(), {
          size: labelSize,
          anchor: "middle",
          baseline: "middle",
        });
      } else {
        const labelStart = pt(cellCx + diagD, labelOffsetY);
        // Leader: vertical leg + 45° diagonal, single path for clean join
        s.polyline(
          [pt(cellCx, cellTopY), pt(cellCx, bendY), labelStart],
          { thin: true }
        );
        s.label(labelStart, t(part.label).bold(), {
          size: labelSize,
          rotate: -45,
          anchor: "start",
          baseline: "middle",
        });
      }
    });

    const widthStyle = this.width
      ? ` style="--codec-width: ${this.width}"`
      : "";

    this.shadow.innerHTML = `
      <div class="container"${widthStyle}>
        <div class="vis"><svg></svg></div>
      </div>
    `;
    s.render(this.shadow.querySelector("svg") as SVGSVGElement);
  }
}
