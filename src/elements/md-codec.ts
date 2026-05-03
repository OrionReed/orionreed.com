import { attr, css } from "./base-element";
import { Padding, Scene, t, type RowItem } from "./draw";
import { pt } from "./geom";
import { SceneElement } from "./scene-element";

interface CodecPart {
  label: string;
  unitSize: number;
  group?: string;
}

// Codec layout constants — used by both scenePadding and draw.
const LABEL_SIZE = 18;
const VERT_H = 8;
const DIAG_D = 14;
const TOTAL_W = 400;
const CELL_H = 64;
const CHAR_FACTOR = 0.55;

export class MdCodec extends SceneElement {
  @attr() width?: string;

  static styles = css`
    :host {
      --scene-max-width: 100%;
    }
  `;

  private parts: CodecPart[] = [];

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
    this.parts = this.parseContent();
    // The width attribute drives the SceneElement's --scene-max-width.
    if (this.width) this.style.setProperty("--scene-max-width", this.width);
    super.render();
  }

  protected scenePadding(): Padding {
    // Top padding accommodates: leader (vertH + diagD) + rotated label
    // height (~length × char_width / sqrt(2)).
    const longestLabel = this.parts.reduce(
      (m, p) => Math.max(m, p.label.length),
      0,
    );
    const top =
      VERT_H + DIAG_D + Math.ceil(longestLabel * LABEL_SIZE * CHAR_FACTOR * 0.71) + 12;
    return { top, bottom: 4, left: 4, right: 4 };
  }

  protected draw(s: Scene): void {
    if (this.parts.length === 0) return;
    const totalUnits = this.parts.reduce((sum, p) => sum + p.unitSize, 0);

    // Each part is a slot. The divider after a part is dashed when the
    // next part shares its group (= a "soft" subdivision), and solid
    // otherwise (= a "hard" boundary between unrelated regions).
    const items = this.parts.map((p, i): RowItem => {
      const next = this.parts[i + 1];
      const sameGroup = next && p.group !== undefined && p.group === next.group;
      return {
        units: p.unitSize,
        divider: sameGroup ? "dashed" : "solid",
      };
    });

    const row = s.row(items, {
      x: 0,
      y: 0,
      h: CELL_H,
      width: TOTAL_W,
    });

    const bendY = row.bounds.y - VERT_H;
    const labelOffsetY = bendY - DIAG_D;
    // Approximate label width in user units; if it fits comfortably
    // inside a cell, render the label INSIDE (centered, not rotated).
    // Otherwise use the leader-line + rotated-label pattern above.
    const charWidth = LABEL_SIZE * CHAR_FACTOR;

    this.parts.forEach((part, i) => {
      const slot = row.slot(i);
      const cellCx = slot.edge("center").x;
      const cellCy = slot.edge("center").y;
      const cellTopY = slot.bounds.y;
      const labelW = part.label.length * charWidth;
      const fitsInside = labelW + 16 < slot.bounds.w;

      if (fitsInside) {
        s.label(pt(cellCx, cellCy), t(part.label).bold(), {
          size: LABEL_SIZE,
          anchor: "middle",
          baseline: "middle",
        });
      } else {
        const labelStart = pt(cellCx + DIAG_D, labelOffsetY);
        // Leader: vertical leg + 45° diagonal, single path for clean join
        s.polyline(
          [pt(cellCx, cellTopY), pt(cellCx, bendY), labelStart],
          { thin: true },
        );
        s.label(labelStart, t(part.label).bold(), {
          size: LABEL_SIZE,
          rotate: -45,
          anchor: "start",
          baseline: "middle",
        });
      }
    });
  }
}
