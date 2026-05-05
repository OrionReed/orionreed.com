// Pixel-perfect dashing — sidesteps `stroke-dasharray` browser quirks
// and corner artifacts by emitting explicit `<path>` `M`/`L`/`A`
// commands at computed dash positions. Works uniformly on lines, polylines,
// arcs, rounded rectangles, circles, and annular sectors.

import type { Point } from "./point";

const TWO_PI = Math.PI * 2;

/** A single component of a stroke path. */
export type Segment =
  | { type: "line"; from: Point; to: Point }
  | { type: "arc"; cx: () => number; cy: () => number; r: () => number; a0: () => number; a1: () => number };

interface AABBSegment {
  type: "line" | "arc";
  length: number;
}
interface LineEval {
  type: "line";
  length: number;
  x1: number; y1: number; x2: number; y2: number;
}
interface ArcEval {
  type: "arc";
  length: number;
  cx: number; cy: number; r: number; a0: number; a1: number;
}
type EvalSeg = LineEval | ArcEval;

function evalSegments(segments: Segment[]): EvalSeg[] {
  const out: EvalSeg[] = [];
  for (const s of segments) {
    if (s.type === "line") {
      const a = s.from.value;
      const b = s.to.value;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      out.push({ type: "line", length: len, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    } else {
      const cx = s.cx(), cy = s.cy(), r = s.r(), a0 = s.a0(), a1 = s.a1();
      out.push({ type: "arc", length: Math.abs(a1 - a0) * r, cx, cy, r, a0, a1 });
    }
  }
  return out;
}

function pointAt(s: EvalSeg, t: number): { x: number; y: number } {
  if (s.type === "line") {
    return { x: s.x1 + (s.x2 - s.x1) * t, y: s.y1 + (s.y2 - s.y1) * t };
  }
  const a = s.a0 + (s.a1 - s.a0) * t;
  return { x: s.cx + s.r * Math.cos(a), y: s.cy + s.r * Math.sin(a) };
}

interface DashGeom {
  dashSize: number;
  gapSize: number;
  N: number;
}

function computeDashGeom(
  length: number,
  closed: boolean,
  dashTarget: number,
  gapTarget: number,
): DashGeom {
  if (length <= 0) return { dashSize: 0, gapSize: 0, N: 0 };
  const period = dashTarget + gapTarget;

  if (!closed) {
    let N = Math.max(2, Math.round((length + gapTarget) / period));
    let gap = (length - N * dashTarget) / (N - 1);
    while (gap < 0 && N > 2) {
      N--;
      gap = (length - N * dashTarget) / (N - 1);
    }
    if (length < 2 * dashTarget || gap < 0) {
      return { dashSize: length, gapSize: 0, N: 1 };
    }
    return { dashSize: dashTarget, gapSize: gap, N };
  }

  let N = Math.max(1, Math.round(length / period));
  let gap = length / N - dashTarget;
  while (gap < 0 && N > 1) {
    N--;
    gap = length / N - dashTarget;
  }
  if (gap < 0) return { dashSize: length, gapSize: 0, N: 1 };
  return { dashSize: dashTarget, gapSize: gap, N };
}

function pathFromTo(
  segs: EvalSeg[],
  start: number,
  end: number,
): string {
  let i = 0;
  let pos = 0;
  while (i < segs.length && pos + segs[i].length < start) {
    pos += segs[i].length;
    i++;
  }
  if (i >= segs.length) return "";

  const segLen = segs[i].length;
  const tStart = segLen > 0 ? (start - pos) / segLen : 0;
  const startPt = pointAt(segs[i], tStart);
  let d = `M ${startPt.x},${startPt.y}`;

  let remaining = end - start;
  let curT = tStart;

  while (remaining > 0 && i < segs.length) {
    const seg = segs[i];
    const lenLeft = (1 - curT) * seg.length;

    if (remaining <= lenLeft) {
      const endT = curT + (seg.length > 0 ? remaining / seg.length : 0);
      const endPt = pointAt(seg, endT);
      if (seg.type === "line") {
        d += ` L ${endPt.x},${endPt.y}`;
      } else {
        const sweepAngle = (seg.a1 - seg.a0) * (endT - curT);
        const largeArc = Math.abs(sweepAngle) > Math.PI ? 1 : 0;
        const sweepFlag = sweepAngle > 0 ? 1 : 0;
        d += ` A ${seg.r},${seg.r} 0 ${largeArc} ${sweepFlag} ${endPt.x},${endPt.y}`;
      }
      return d;
    }

    const segEnd = pointAt(seg, 1);
    if (seg.type === "line") {
      d += ` L ${segEnd.x},${segEnd.y}`;
    } else {
      const sweepAngle = (seg.a1 - seg.a0) * (1 - curT);
      const largeArc = Math.abs(sweepAngle) > Math.PI ? 1 : 0;
      const sweepFlag = sweepAngle > 0 ? 1 : 0;
      d += ` A ${seg.r},${seg.r} 0 ${largeArc} ${sweepFlag} ${segEnd.x},${segEnd.y}`;
    }
    remaining -= lenLeft;
    i++;
    curT = 0;
  }
  return d;
}

interface DashOpts {
  closed?: boolean;
  dashSize?: number;  // default 4
  gapSize?: number;   // default 3
  capExtension?: number;  // optical compensation for round caps
}

/**
 * Generate SVG path data for a dashed stroke through the given segments.
 * Returns a single `d` string consisting of multiple `M…L…/A…` runs (one
 * per dash). Place the result in a `<path d="…">` with `fill="none"`.
 */
export function dashedPath(segments: Segment[], opts: DashOpts = {}): string {
  const segs = evalSegments(segments);
  if (segs.length === 0) return "";

  const closed = opts.closed ?? false;
  const ext = opts.capExtension ?? 0;
  const dashTarget = Math.max(0.001, (opts.dashSize ?? 4) - ext);
  const gapTarget = (opts.gapSize ?? 3) + ext;

  const total = segs.reduce((sum, s) => sum + s.length, 0);
  const { dashSize, gapSize, N } = computeDashGeom(total, closed, dashTarget, gapTarget);

  if (N === 0) return "";
  if (N === 1) return pathFromTo(segs, 0, total);

  const period = dashSize + gapSize;
  const out: string[] = [];
  for (let i = 0; i < N; i++) {
    const start = i * period;
    const end = start + dashSize;
    out.push(pathFromTo(segs, start, end));
  }
  return out.join(" ");
}

export { TWO_PI };
