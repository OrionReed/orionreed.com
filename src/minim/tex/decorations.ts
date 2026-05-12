// Derived shapes that decorate a tex Part. Each one re-derives from
// `part.bounds` so the decoration tracks its target through any
// re-measurement or animation.
//
// Mount as a child of the parent TexShape if you want the decoration
// to follow the formula's transform:
//
//      const eq = s(tex`${part("a", "...")} ...`);
//      eq.add(brace(eq.parts.a));

import { computed } from "../core/signal";
import { Shape } from "../scene/shape";
import { aabb } from "../scene/bounds";
import { tokens } from "../shapes/tokens";
import type { Part } from "./parts";

export interface DecorationOpts {
  /** Stroke color. Default: `tokens.stroke`. */
  stroke?: string;
  /** Stroke width. Default: `tokens.thinWeight`. */
  weight?: number;
  /** Pad between the part's bounds and the decoration. Default: 2. */
  gap?: number;
}

const applyStroke = (s: Shape, opts: DecorationOpts) => {
  s.attr("stroke", opts.stroke ?? tokens.stroke);
  s.attr("stroke-width", opts.weight ?? tokens.thinWeight);
  s.attr("vector-effect", "non-scaling-stroke");
  s.attr("fill", "none");
};

/** Curly brace below (or above) a part. Reactive on `part.bounds`. */
export function brace(
  part: Part,
  opts: DecorationOpts & {
    /** "below" (default) or "above". */
    placement?: "above" | "below";
    /** Brace amplitude in local-frame units. Default: 5. */
    height?: number;
  } = {},
): Shape {
  const placement = opts.placement ?? "below";
  const height = opts.height ?? 5;
  const gap = opts.gap ?? 3;

  const d = computed(() => {
    const b = part.bounds.value;
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

  const s = new Shape(
    "path",
    () => {
      const b = part.bounds.value;
      const baseY = placement === "below" ? b.y + b.h + gap : b.y - gap;
      const tip = baseY + (placement === "below" ? height : -height);
      return aabb(b.x, Math.min(baseY, tip), b.w, Math.abs(tip - baseY));
    },
    {},
  );
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
  const gap = opts.gap ?? 2;
  const corner = opts.corner ?? 2;
  const s = new Shape(
    "rect",
    () => {
      const b = part.bounds.value;
      return aabb(b.x - gap, b.y - gap, b.w + 2 * gap, b.h + 2 * gap);
    },
    {},
  );
  s.attr("x", computed(() => part.bounds.value.x - gap));
  s.attr("y", computed(() => part.bounds.value.y - gap));
  s.attr("width", computed(() => part.bounds.value.w + 2 * gap));
  s.attr("height", computed(() => part.bounds.value.h + 2 * gap));
  s.attr("rx", corner);
  s.attr("ry", corner);
  applyStroke(s, opts);
  return s;
}

/** Underline at the baseline of a part. */
export function underline(
  part: Part,
  opts: DecorationOpts = {},
): Shape {
  const gap = opts.gap ?? 2;
  const s = new Shape(
    "line",
    () => {
      const b = part.bounds.value;
      return aabb(b.x, b.y + b.h + gap, b.w, 0);
    },
    {},
  );
  s.attr("x1", computed(() => part.bounds.value.x));
  s.attr(
    "y1",
    computed(() => part.bounds.value.y + part.bounds.value.h + gap),
  );
  s.attr(
    "x2",
    computed(() => part.bounds.value.x + part.bounds.value.w),
  );
  s.attr(
    "y2",
    computed(() => part.bounds.value.y + part.bounds.value.h + gap),
  );
  s.attr("stroke-linecap", "round");
  applyStroke(s, opts);
  return s;
}

/** Diagonal strikethrough across a part (from bottom-left to
 *  top-right). */
export function cross(
  part: Part,
  opts: DecorationOpts = {},
): Shape {
  const gap = opts.gap ?? 1;
  const s = new Shape("line", () => part.bounds.value, {});
  s.attr("x1", computed(() => part.bounds.value.x - gap));
  s.attr(
    "y1",
    computed(() => part.bounds.value.y + part.bounds.value.h + gap),
  );
  s.attr(
    "x2",
    computed(() => part.bounds.value.x + part.bounds.value.w + gap),
  );
  s.attr("y2", computed(() => part.bounds.value.y - gap));
  s.attr("stroke-linecap", "round");
  applyStroke(s, opts);
  return s;
}
