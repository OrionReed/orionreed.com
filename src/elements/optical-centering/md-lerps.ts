// "One .to(), every type" — showcase for minim's generalized tween
// engine. The struct framework registers a `lerp` op for value types
// (Vec, Box, Color, …); `Signal.prototype.to` looks it up via a
// hidden prototype slot and dispatches. Adding a new value type
// (with a `lerp`) gets you `.to()` for free, no engine changes.
//
// Five rows — each animates a different value type. They all run
// simultaneously via the same `.to()` call shape:
//
//   yield [
//     num.to(0.85, 0.6),
//     pos.to({ x: 220, y: 0 }, 0.6),
//     box.to({ x: 60, y: 0, w: 60, h: 36 }, 0.6),
//     col.to({ r: 0.95, g: 0.4, b: 0.2, a: 1 }, 0.6),
//     txt.to("goodbye", 0.6),
//   ]
//
// Strings (and other non-record types) use `lerpable(initial, lerp)` —
// a tiny helper that stamps the same `[LERP]` slot on a plain Signal.

import {
  Anchor,
  Box,
  Color,
  Diagram,
  Mount,
  Vec,
  cell,
  circle,
  label,
  lerpable,
  pt,
  rect,
  rgb,
  type Lerp,
} from "../../minim";

const W = 640;
const H = 320;
const ROW_H = 50;
const TOP = 50;
const LABEL_X = 24;
const VIS_X = 110;
const VIS_W = 220;
const READ_X = VIS_X + VIS_W + 24;
const DUR = 0.7;
const DWELL = 0.45;

/** Shrink-then-grow string lerp. Visible length goes
 *  `a.length → 0 → b.length` over `t ∈ [0, 1]`; the source switches
 *  at the midpoint, so the text reads as "type out, then type in". */
const stringLerp: Lerp<string> = (a, b, t) => {
  if (t <= 0.5) return a.slice(0, Math.round(a.length * (1 - t * 2)));
  return b.slice(0, Math.round(b.length * (t - 0.5) * 2));
};

const fmtNum = (n: number) => n.toFixed(2);
const fmtVec = (v: { x: number; y: number }) =>
  `(${Math.round(v.x)}, ${Math.round(v.y)})`;
const fmtBox = (b: { w: number; h: number }) =>
  `${Math.round(b.w)}×${Math.round(b.h)}`;
const fmtColor = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b]
    .map((x) =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

// Per-row geometry. Visuals get drawn within `[VIS_X, VIS_X + VIS_W]`
// horizontally; the per-row `y` baseline locates each row vertically.
const rowY = (i: number) => TOP + ROW_H * i;

export class MdLerps extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    s(
      label(view.top.down(22), "one .to(), every value type", {
        size: 13,
        align: Anchor.Center,
        opacity: 0.7,
      }),
      label(
        view.bottom.up(20),
        "Signal.prototype.to dispatches via [LERP] on the prototype chain — Vec, Box, Color all register their own; lerpable(...) wires it for arbitrary types.",
        { size: 10, align: Anchor.Center, opacity: 0.45 },
      ),
    );

    // ── State (one per value type) ─────────────────────────────────
    //
    // Each is a different `lerp`-capable reactive: a raw `Signal<number>`
    // (default scalar lerp), a `Reactive<V>` / `Reactive<Box>` /
    // `Reactive<C>` (lerp registered as a struct op), and a
    // `Signal<string>` whose lerp was wired via `lerpable(...)`. They
    // ALL expose `.to(target, dur)` because they all carry a [LERP] slot.
    const baseY = (i: number) => rowY(i) + 9;
    const num = cell(0.15);
    const pos = Vec.signal({ x: VIS_X + 12, y: baseY(1) });
    const box = Box.signal({ x: VIS_X + 4, y: rowY(2) - 6, w: 30, h: 20 });
    const col = rgb(0.4, 0.6, 0.9);
    const txt = lerpable("hello", stringLerp);

    // ── Visuals ────────────────────────────────────────────────────
    //
    // Each row: a left-aligned type-name label, a track + bound visual,
    // and a right-aligned live readout. The visuals are bound to the
    // state above; nothing reads through `this`.
    const rowLabel = (i: number, name: string) =>
      label(pt(LABEL_X, baseY(i)), name, {
        size: 11,
        align: Anchor.Left,
        opacity: 0.7,
      });
    const readout = (i: number, content: Parameters<typeof label>[1]) =>
      label(pt(READ_X, baseY(i)), content, {
        size: 11,
        align: Anchor.Left,
        opacity: 0.65,
      });
    const track = (
      x: number,
      y: number,
      w: number,
      h: number,
      alpha: number,
    ) =>
      rect(x, y, w, h, {
        stroke: "transparent",
        fill: `rgba(127,127,127,${alpha})`,
        corner: Math.min(h / 2, 4),
      });

    // Row 0 — number: width-bound fill bar over a track.
    s(
      rowLabel(0, "number"),
      track(VIS_X, rowY(0) + 4, VIS_W, 10, 0.18),
      rect(VIS_X, rowY(0) + 4, num.derive((n) => n * VIS_W), 10, {
        stroke: "transparent",
        fill: true,
      }),
      readout(0, num.derive(fmtNum)),
    );

    // Row 1 — Vec: a dot whose center IS the Vec signal.
    s(
      rowLabel(1, "Vec"),
      track(VIS_X, rowY(1) + 5, VIS_W, 8, 0.1),
      circle(pos, 5, { fill: true, stroke: "transparent" }),
      readout(1, pos.derive(fmtVec)),
    );

    // Row 2 — Box: every axis (x, y, w, h) is a Signal<number> lens
    // projection of `box`; .to() drives all four through Box.lerp.
    s(
      rowLabel(2, "Box"),
      track(VIS_X, rowY(2) - 14, VIS_W, 36, 0.1),
      rect(box.x, box.y, box.w, box.h, {
        stroke: "transparent",
        fill: true,
        corner: 3,
      }),
      readout(2, box.derive(fmtBox)),
    );

    // Row 3 — Color: `col.css` is a lazy getter (cached as own-prop on
    // first read) that yields a ReadonlySignal<string>. Bind it as fill.
    s(
      rowLabel(3, "Color"),
      rect(VIS_X, rowY(3) - 6, VIS_W, 22, {
        stroke: "transparent",
        fill: col.css,
        corner: 3,
      }),
      readout(3, col.derive(fmtColor)),
    );

    // Row 4 — string: lerpable() stamps the [LERP] slot on a plain
    // Signal<string>. The same .to() machinery the structs use works
    // through the same dispatch.
    s(
      rowLabel(4, "string"),
      track(VIS_X, rowY(4) - 6, VIS_W, 22, 0.08),
      label(pt(VIS_X + 10, baseY(4)), txt, {
        size: 13,
        align: Anchor.Left,
      }),
      readout(4, txt.derive((str) => `len=${str.length}`)),
    );

    // ── Drive ──────────────────────────────────────────────────────
    //
    // Three keyframes; each transition runs all five .to()s as one
    // parallel batch — `yield [a.to(...), b.to(...), …]` — so they
    // all step through the same `tweenStep` function in core/tween.
    const FRAMES = [
      {
        n: 0.85,
        v: { x: VIS_X + VIS_W - 12, y: baseY(1) },
        b: { x: VIS_X + VIS_W - 90, y: rowY(2) - 10, w: 80, h: 26 },
        c: { r: 0.95, g: 0.45, b: 0.2, a: 1 },
        t: "morphing",
      },
      {
        n: 0.5,
        v: { x: VIS_X + VIS_W / 2, y: baseY(1) },
        b: { x: VIS_X + VIS_W / 2 - 25, y: rowY(2) - 4, w: 50, h: 16 },
        c: { r: 0.36, g: 0.78, b: 0.45, a: 1 },
        t: "between",
      },
      {
        n: 0.15,
        v: { x: VIS_X + 12, y: baseY(1) },
        b: { x: VIS_X + 4, y: rowY(2) - 6, w: 30, h: 20 },
        c: { r: 0.4, g: 0.6, b: 0.9, a: 1 },
        t: "hello",
      },
    ];

    this.anim.loop(function* () {
      for (const f of FRAMES) {
        yield [
          num.to(f.n, DUR),
          pos.to(f.v, DUR),
          box.to(f.b, DUR),
          col.to(f.c, DUR),
          txt.to(f.t, DUR),
        ];
        yield DWELL;
      }
    });
  }
}
