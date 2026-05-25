// box-ops.ts — Box-relational propagator combinators.
//
// Edge-to-edge, center-to-center, contain-within. The combinators
// here let you describe layouts in terms of relations between
// boxes: "anchor B's left edge to A's right edge plus 8px",
// "center C inside D", etc. Drag any box → relations resolve.

import type { Num, Signal, Writable } from "../signals";
import { value } from "../signals";
import { type Box } from "./box";
import { type Propagator, propagator } from "./propagator";

type WNum = Writable<Num>;
const asW = <T>(s: T): WNum => s as unknown as WNum;
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous opt
type ValOrSig = number | Signal<any>;

// ─── Side identifiers ────────────────────────────────────────────

export type Side = "left" | "right" | "top" | "bottom";

const sideOf = (b: Box, side: Side): WNum => {
  switch (side) {
    case "left":   return asW(b.x);
    case "right":  return asW(b.x); // computed as x + w in propagator
    case "top":    return asW(b.y);
    case "bottom": return asW(b.y);
  }
};

// ─── attach ─────────────────────────────────────────────────────

/** Attach `b`'s `bSide` to `a`'s `aSide` with optional gap.
 *  Examples:
 *
 *    attach(panel, sidebar, "right", "left", { gap: 8 })
 *      // sidebar.left = panel.right + 8
 *
 *    attach(header, body, "bottom", "top")
 *      // body.top = header.bottom (no gap)
 *
 *  The DRAGGED side propagates: drag a, b follows; drag b, a
 *  follows back. */
export function attach(
  a: Box,
  b: Box,
  aSide: Side,
  bSide: Side,
  opts: { gap?: ValOrSig } = {},
): Propagator[] {
  const gapDeps: Signal<unknown>[] =
    typeof opts.gap === "object" ? [opts.gap as Signal<unknown>] : [];
  const gap = (): number => value(opts.gap ?? 0);

  // Compute "where the side actually is" given the box.
  const sideValue = (box: Box, side: Side): number => {
    switch (side) {
      case "left":   return box.x.value;
      case "right":  return box.x.value + box.w.value;
      case "top":    return box.y.value;
      case "bottom": return box.y.value + box.h.value;
    }
  };

  // Apply: write box's side to value, by setting position. Width
  // / height stay unchanged. Side determines whether x or y moves.
  const writeSide = (box: Box, side: Side, v: number): void => {
    switch (side) {
      case "left":   asW(box.x).value = v; break;
      case "right":  asW(box.x).value = v - box.w.value; break;
      case "top":    asW(box.y).value = v; break;
      case "bottom": asW(box.y).value = v - box.h.value; break;
    }
  };

  return [
    // a moved → reposition b.
    propagator(
      [a.x, a.y, a.w, a.h, b.w, b.h, ...gapDeps],
      [asW(b.x), asW(b.y)],
      () => writeSide(b, bSide, sideValue(a, aSide) + gap()),
    ),
    // b moved → reposition a (uncommon but bidirectional).
    propagator(
      [b.x, b.y, b.w, b.h, a.w, a.h, ...gapDeps],
      [asW(a.x), asW(a.y)],
      () => writeSide(a, aSide, sideValue(b, bSide) - gap()),
    ),
  ];
}

// ─── center inside ──────────────────────────────────────────────

/** Center `inner` inside `outer`. `inner.w` and `inner.h` are
 *  preserved; `inner.x` and `inner.y` are computed.
 *
 *  Reactive: drag outer, inner re-centers. Drag inner, outer
 *  re-centers around it (bidirectional). */
export function centerInside(outer: Box, inner: Box): Propagator[] {
  return [
    // outer drives → re-center inner.
    propagator(
      [outer.x, outer.y, outer.w, outer.h, inner.w, inner.h],
      [asW(inner.x), asW(inner.y)],
      () => {
        asW(inner.x).value = outer.x.value + (outer.w.value - inner.w.value) / 2;
        asW(inner.y).value = outer.y.value + (outer.h.value - inner.h.value) / 2;
      },
    ),
    // inner drag → translate outer to keep it centered.
    propagator(
      [inner.x, inner.y],
      [asW(outer.x), asW(outer.y)],
      () => {
        const targetX = inner.x.value - (outer.w.value - inner.w.value) / 2;
        const targetY = inner.y.value - (outer.h.value - inner.h.value) / 2;
        if (Math.abs(targetX - outer.x.value) > 1e-9) asW(outer.x).value = targetX;
        if (Math.abs(targetY - outer.y.value) > 1e-9) asW(outer.y).value = targetY;
      },
    ),
  ];
}

// ─── pin edge ───────────────────────────────────────────────────

/** Pin one edge of a box to a fixed coordinate. The OPPOSITE
 *  edge stays put; size adjusts. (E.g. pin left to 0 keeps the
 *  right edge where it was, growing/shrinking width.)
 *
 *  Useful for "this panel's right edge is always on the viewport
 *  edge, but its width is whatever it needs to be." */
export function pinEdge(b: Box, side: Side, target: ValOrSig): Propagator {
  const targetDeps: Signal<unknown>[] =
    typeof target === "object" ? [target as Signal<unknown>] : [];
  const t = () => value(target);

  return propagator(
    [b.x, b.y, b.w, b.h, ...targetDeps],
    [asW(b.x), asW(b.y), asW(b.w), asW(b.h)],
    () => {
      const tv = t();
      switch (side) {
        case "left": {
          const right = b.x.value + b.w.value;
          asW(b.x).value = tv;
          asW(b.w).value = right - tv;
          break;
        }
        case "right": {
          asW(b.w).value = tv - b.x.value;
          break;
        }
        case "top": {
          const bot = b.y.value + b.h.value;
          asW(b.y).value = tv;
          asW(b.h).value = bot - tv;
          break;
        }
        case "bottom": {
          asW(b.h).value = tv - b.y.value;
          break;
        }
      }
    },
  );
}

// ─── lock dimension ─────────────────────────────────────────────

/** Lock a box's width or height to a fixed value (or signal). */
export function lockSize(b: Box, axis: "w" | "h", value_: ValOrSig): Propagator {
  const deps: Signal<unknown>[] =
    typeof value_ === "object" ? [value_ as Signal<unknown>] : [];
  const target = () => value(value_);
  const cell = axis === "w" ? asW(b.w) : asW(b.h);
  return propagator([cell, ...deps], [cell], () => {
    if (cell.value !== target()) cell.value = target();
  });
}

// ─── follow (one-way mirror) ────────────────────────────────────

/** Make `follower` mirror `leader` exactly (one-way). Useful for
 *  shadowing, reflection effects, or "this minimap's pose tracks
 *  that viewport's pose." */
export function follow(leader: Box, follower: Box): Propagator {
  return propagator(
    [leader.x, leader.y, leader.w, leader.h],
    [asW(follower.x), asW(follower.y), asW(follower.w), asW(follower.h)],
    () => {
      asW(follower.x).value = leader.x.value;
      asW(follower.y).value = leader.y.value;
      asW(follower.w).value = leader.w.value;
      asW(follower.h).value = leader.h.value;
    },
  );
}
