import {
  Diagram,
  Path,
  Pivot,
  Scene,
  attr,
  label,
  line,
  path,
  rect,
  t,
} from "../minim";

interface CodecPart {
  label: string;
  unitSize: number;
  group?: string;
}

const LABEL_SIZE = 18;
const VERT_H = 8;
const DIAG_D = 14;
const TOTAL_W = 400;
const CELL_H = 64;
const CHAR_FACTOR = 0.55;
const LEADER_ANGLE = -Math.PI / 4;

function parseContent(text: string): CodecPart[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((raw): CodecPart => {
    const colon = raw.indexOf(":");
    if (colon === -1) return { label: raw, unitSize: 1 };
    const lbl = raw.slice(0, colon).trim();
    const rest = raw.slice(colon + 1).trim();
    if (!rest) return { label: lbl, unitSize: 1 };
    const m = rest.match(
      /^(?:(\d+)\s+([a-zA-Z])|([a-zA-Z])\s+(\d+)|(\d+)|([a-zA-Z]))$/,
    );
    if (!m) return { label: lbl, unitSize: 1 };
    const [, s1, g1, g2, s2, sOnly, gOnly] = m;
    const unitSize = parseInt(s1 || s2 || sOnly || "1", 10);
    const group = g1 || g2 || gOnly || undefined;
    return { label: lbl, unitSize, group };
  });
}

export class MdCodec extends Diagram {
  @attr() width?: string;

  protected setup(s: Scene): void {
    if (this.width) this.style.setProperty("--scene-max-width", this.width);

    const parts = parseContent(this.textContent?.trim() ?? "");
    if (parts.length === 0) return;

    const charWidth = LABEL_SIZE * CHAR_FACTOR;

    const row = s(rect(0, 0, TOTAL_W, CELL_H));
    const slots = row.bounds.split(
      "x",
      parts.map((p) => p.unitSize),
    );

    // Dividers between adjacent slots — dashed when the two parts share
    // a group (visual grouping), solid otherwise.
    parts.forEach((part, i) => {
      if (i === parts.length - 1) return;
      const next = parts[i + 1];
      const sameGroup = part.group !== undefined && part.group === next.group;
      s(line(slots[i].tr, slots[i].br, { thin: true, dashed: sameGroup }));
    });

    // Labels: inside the slot when they fit, otherwise on a leader path
    // angled out of the slot's top edge with the label rotated to match.
    parts.forEach((part, i) => {
      const slot = slots[i];
      const labelW = part.label.length * charWidth;
      const fitsInside = labelW + 16 < slot.w.value;

      if (fitsInside) {
        s(label(slot.center, t(part.label).bold(), { size: LABEL_SIZE }));
        return;
      }

      const leader = path(slot.top).up(VERT_H).along(LEADER_ANGLE, DIAG_D);
      s(new Path(leader, { thin: true }));
      s(
        label(leader.tip.position, t(part.label).bold(), {
          size: LABEL_SIZE,
          anchor: Pivot.LEFT,
          rotate: leader.tip.angle,
        }),
      );
    });
  }
}
