// Derived shapes that decorate a tex Part. Each one re-derives from
// `part.box` so the decoration tracks its target through any
// re-measurement or animation.
//
// Mount as a child of the parent TexShape if you want the decoration
// to follow the formula's transform:
//
//      const eq = s(tex`${part("a", "...")} ...`);
//      eq.add(brace(eq.parts.a));

import { computed, type ReadonlySignal } from "@minim/core";
import { Shape } from "@minim/shapes";
// Plain Box constructor — imported renamed to avoid shadowing the
// `box(part)` decoration exported below.
import { box as mkBox, type Box } from "@minim/values";
import { tokens } from "@minim/shapes";
import type { Part } from "./parts";

export interface DecorationOpts {
  /** Stroke color. Default: `tokens.stroke`. */
  stroke?: string;
  /** Stroke width. Default: `tokens.thinWeight`. */
  weight?: number;
  /** Pad between the part's bounds and the decoration. Default per
   *  decoration (see `tokens.decoration`). */
  gap?: number;
}

const applyStroke = (s: Shape, opts: DecorationOpts) => {
  s.attr("stroke", opts.stroke ?? tokens.stroke);
  s.attr("stroke-width", opts.weight ?? tokens.thinWeight);
  s.attr("vector-effect", "non-scaling-stroke");
  s.attr("fill", "none");
};

/** A `<rect>` whose x/y/w/h and Box all derive from the same layout
 *  signal — single source of truth, one re-render per change. */
function rectFromBox(layout: ReadonlySignal<Box>): Shape {
  const s = new Shape("rect", () => layout.value);
  s.attr("x", () => layout.value.x);
  s.attr("y", () => layout.value.y);
  s.attr("width", () => layout.value.w);
  s.attr("height", () => layout.value.h);
  return s;
}

interface LineEnds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A `<line>` whose endpoints (and Box) derive from the same layout
 *  signal. */
function lineFromEnds(layout: ReadonlySignal<LineEnds>): Shape {
  const s = new Shape("line", () => {
    const e = layout.value;
    const x = Math.min(e.x1, e.x2);
    const y = Math.min(e.y1, e.y2);
    return mkBox(x, y, Math.abs(e.x2 - e.x1), Math.abs(e.y2 - e.y1));
  });
  s.attr("x1", () => layout.value.x1);
  s.attr("y1", () => layout.value.y1);
  s.attr("x2", () => layout.value.x2);
  s.attr("y2", () => layout.value.y2);
  return s;
}

/** Curly brace below (or above) a part. Reactive on `part.box`. */
export function brace(
  part: Part,
  opts: DecorationOpts & {
    /** "below" (default) or "above". */
    placement?: "above" | "below";
    /** Brace amplitude in local-frame units. */
    height?: number;
  } = {},
): Shape {
  const placement = opts.placement ?? "below";
  const height = opts.height ?? tokens.decoration.braceHeight;
  const gap = opts.gap ?? tokens.decoration.braceGap;

  const d = computed(() => {
    const b = part.box.value;
    const x0 = b.x;
    const x1 = b.x + b.w;
    const baseY = placement === "below" ? b.y + b.h + gap : b.y - gap;
    const dir = placement === "below" ? 1 : -1;
    const tip = baseY + dir * height;
    const mid = baseY + dir * (height / 2);
    const cx = (x0 + x1) / 2;
    const r = Math.min(height / 2, b.w / 4, 4);
    return [
      `M ${x0} ${baseY}`,
      `Q ${x0} ${mid} ${x0 + r} ${mid}`,
      `L ${cx - r} ${mid}`,
      `Q ${cx} ${mid} ${cx} ${tip}`,
      `Q ${cx} ${mid} ${cx + r} ${mid}`,
      `L ${x1 - r} ${mid}`,
      `Q ${x1} ${mid} ${x1} ${baseY}`,
    ].join(" ");
  });

  const s = new Shape("path", () => {
    const b = part.box.value;
    const baseY = placement === "below" ? b.y + b.h + gap : b.y - gap;
    const tip = baseY + (placement === "below" ? height : -height);
    return mkBox(b.x, Math.min(baseY, tip), b.w, Math.abs(tip - baseY));
  });
  s.attr("d", d);
  s.attr("stroke-linecap", "round");
  s.attr("stroke-linejoin", "round");
  applyStroke(s, opts);
  return s;
}

/** Surrounding rectangle around a part, inset by `gap`. */
export function box(
  part: Part,
  opts: DecorationOpts & { corner?: number } = {},
): Shape {
  const gap = opts.gap ?? tokens.decoration.gap;
  const corner = opts.corner ?? tokens.corner;
  const layout = computed(() => {
    const b = part.box.value;
    return mkBox(b.x - gap, b.y - gap, b.w + 2 * gap, b.h + 2 * gap);
  });
  const s = rectFromBox(layout);
  s.attr("rx", corner);
  s.attr("ry", corner);
  applyStroke(s, opts);
  return s;
}

/** Underline at the baseline of a part. */
export function underline(part: Part, opts: DecorationOpts = {}): Shape {
  const gap = opts.gap ?? tokens.decoration.gap;
  const layout = computed(() => {
    const b = part.box.value;
    const y = b.y + b.h + gap;
    return { x1: b.x, y1: y, x2: b.x + b.w, y2: y };
  });
  const s = lineFromEnds(layout);
  s.attr("stroke-linecap", "round");
  applyStroke(s, opts);
  return s;
}

/** Diagonal strikethrough across a part (from bottom-left to
 *  top-right). */
export function cross(part: Part, opts: DecorationOpts = {}): Shape {
  const gap = opts.gap ?? tokens.decoration.crossGap;
  const layout = computed(() => {
    const b = part.box.value;
    return {
      x1: b.x - gap,
      y1: b.y + b.h + gap,
      x2: b.x + b.w + gap,
      y2: b.y - gap,
    };
  });
  const s = lineFromEnds(layout);
  s.attr("stroke-linecap", "round");
  applyStroke(s, opts);
  return s;
}
