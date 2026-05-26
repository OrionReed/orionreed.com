// Codec lenses: text ↔ typed value, both ways.
//
// Two stacked rows, each backed by a different codec from
// `signals/values/codecs.ts`:
//
//   Top   — Color ↔ "#rrggbb" (`hexFromColor` / `colorFromHex`)
//   Bottom — seconds Num ↔ "MM:SS" (`textFromSeconds` / `secondsFromText`)
//
// Within each row:
//   - The "source" is the typed signal (Color / seconds Num).
//   - The codec view is a writable text signal — reads format, writes
//     parse and round-trip back through to the source.
//   - Drag the geometric handle → source updates → text view updates
//     (the format direction).
//   - Click a preset chip → text view's `.value =` writes the literal
//     string → the codec's bwd parses it → source updates → handle
//     position re-renders (the parse direction).
//
// Both directions are the same lens; only which side gets `.value =`
// determines the propagation direction. The same `Cls.lens(parent,
// fwd, bwd)` autofuses with the rest of the lens graph (drag chains,
// Range#slider, etc.).

import {
  Anchor,
  computed,
  Diagram,
  handle,
  hexFromColor,
  label,
  line,
  Mount,
  num,
  range,
  rect,
  rgb,
  textFromSeconds,
  vec,
  type Writable,
} from "../../minim";

const VIEW_W = 600;
const VIEW_H = 340;

// Color row
const COLOR_BOX_X = 60;
const COLOR_BOX_Y = 60;
const COLOR_BOX_W = 220;
const COLOR_BOX_H = 110;
const COLOR_PRESETS: Array<[string, string]> = [
  ["#e25c5c", "red"],
  ["#7ed321", "grn"],
  ["#5b8def", "blu"],
  ["#1a1a1a", "blk"],
  ["#ffffff", "wht"],
];

// Time row
const TIME_RAIL_X0 = 60;
const TIME_RAIL_X1 = 540;
const TIME_RAIL_Y = 240;
const TIME_MAX_SEC = 120; // 2 minutes
const TIME_PRESETS = ["00:15", "00:45", "01:30"];

export class MdCodecLens extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(VIEW_W, VIEW_H);

    s(
      label(view.top.down(20), "Codec lenses · text ↔ typed value, both ways", {
        size: 13,
        align: Anchor.Center,
        opacity: 0.75,
      }),
    );

    this.colorRow(s);
    this.timeRow(s);

    s(
      label(
        view.bottom.up(14),
        "drag the handle → format direction · click a chip → parse direction",
        { size: 10, align: Anchor.Center, opacity: 0.5 },
      ),
    );
  }

  // ── Color ↔ #rrggbb ─────────────────────────────────────────────────
  private colorRow(s: Mount): void {
    // Source: a writable Color seeded with a mid-spectrum colour. The
    // r/g axes ride on its field lenses for drag input.
    const color = rgb(0.45, 0.7, 0.9);

    // The codec lens. `hex` IS the color, viewed as text — reading
    // formats, writing parses. Both directions live, both bidirectional.
    const hex = hexFromColor(color);

    // Drag area: x ↔ red, y ↔ green. Blue is fixed for visual sanity
    // (the demo's about codecs, not colour pickers).
    const xRange = range(COLOR_BOX_X, COLOR_BOX_X + COLOR_BOX_W);
    const yRange = range(COLOR_BOX_Y, COLOR_BOX_Y + COLOR_BOX_H);
    const swatchPos = vec(xRange.slider(color.r), yRange.slider(color.g));

    s(
      rect(COLOR_BOX_X, COLOR_BOX_Y, COLOR_BOX_W, COLOR_BOX_H, {
        fill: "#f7f7f7",
        stroke: "#ddd",
        corner: 6,
      }),
    );

    s(
      handle(swatchPos, {
        r: 14,
        fill: computed(() => {
          const c = color.value;
          return `rgb(${(c.r * 255) | 0}, ${(c.g * 255) | 0}, ${(c.b * 255) | 0})`;
        }),
      }),
    );

    // Live hex label — `hex.value` is the codec's format direction.
    s(
      label(vec(COLOR_BOX_X + COLOR_BOX_W + 30, COLOR_BOX_Y + 18), "hex:", {
        size: 11,
        align: Anchor.Left,
        opacity: 0.6,
      }),
      label(
        vec(COLOR_BOX_X + COLOR_BOX_W + 70, COLOR_BOX_Y + 18),
        computed(() => hex.value),
        { size: 14, align: Anchor.Left, opacity: 0.95 },
      ),
    );

    // Preset chips. Click writes the literal hex string to the
    // codec view; the bwd parses and updates the source Color, which
    // pushes the swatch handle to the matching position. One write
    // travels through both legs of the chain.
    const chipsX = COLOR_BOX_X + COLOR_BOX_W + 30;
    const chipsY = COLOR_BOX_Y + 50;
    const CHIP_W = 38;
    const CHIP_H = 22;
    COLOR_PRESETS.forEach(([code, name], i) => {
      const cx = chipsX + (i % 3) * (CHIP_W + 6);
      const cy = chipsY + Math.floor(i / 3) * (CHIP_H + 6);
      const chip = s(rect(cx, cy, CHIP_W, CHIP_H, { fill: code, corner: 4, stroke: "none" }));
      s(
        label(vec(cx + CHIP_W / 2, cy + CHIP_H / 2 + 0.5), name, {
          size: 9,
          align: Anchor.Center,
          // Black text on light chips, white on dark — quick contrast hack.
          fill: code === "#ffffff" ? "#222" : "white",
          opacity: 0.9,
        }),
      );
      chip.on("click", () => {
        hex.value = code;
      });
      chip.el.style.cursor = "pointer";
    });

    // Annotation
    s(
      label(vec(COLOR_BOX_X, COLOR_BOX_Y - 12), "hexFromColor(color)", {
        size: 10,
        align: Anchor.Left,
        opacity: 0.5,
      }),
    );
  }

  // ── seconds Num ↔ "MM:SS" Text ──────────────────────────────────────
  private timeRow(s: Mount): void {
    // Source: writable seconds Num.
    const seconds = num(45);

    // Codec view: writable text. Reads format MM:SS; writes parse back.
    const time = textFromSeconds(seconds);

    // Scrubber: a Range over the rail's pixel span; its slider
    // bidirectionally maps the secs Num through `[0, MAX]` time space.
    const tRange = range(0, TIME_MAX_SEC);
    const railRange = range(TIME_RAIL_X0, TIME_RAIL_X1);
    const tParam = tRange.slider(seconds); // 0..1 ↔ seconds 0..MAX
    const knobX = railRange.slider(tParam); // pixel ↔ t param
    const knobPos = vec(knobX, TIME_RAIL_Y);

    s(
      line(vec(TIME_RAIL_X0, TIME_RAIL_Y), vec(TIME_RAIL_X1, TIME_RAIL_Y), {
        thin: true,
        opacity: 0.35,
        cap: "round",
      }),
    );

    // Tick marks every 30 seconds, derived RO from tRange.sample.
    for (let secs = 0; secs <= TIME_MAX_SEC; secs += 30) {
      const tx = TIME_RAIL_X0 + (secs / TIME_MAX_SEC) * (TIME_RAIL_X1 - TIME_RAIL_X0);
      s(
        line(vec(tx, TIME_RAIL_Y - 4), vec(tx, TIME_RAIL_Y + 4), {
          thin: true,
          opacity: 0.4,
        }),
      );
    }

    const knob = s(handle(knobPos as Writable<typeof knobPos>, { r: 9, fill: "#5b8def" }));
    // 1-D slider — override the default "grab" cursor.
    knob.el.style.cursor = "ew-resize";

    // Live time label. Reads from `time` (the codec view) — equivalent
    // to formatting `seconds.value` as MM:SS.
    s(
      label(vec(TIME_RAIL_X0, TIME_RAIL_Y + 32), "time:", {
        size: 11,
        align: Anchor.Left,
        opacity: 0.6,
      }),
      label(
        vec(TIME_RAIL_X0 + 38, TIME_RAIL_Y + 32),
        computed(() => time.value),
        { size: 14, align: Anchor.Left, opacity: 0.95 },
      ),
    );

    // Preset buttons. `time.value = "01:30"` writes through the codec
    // (parse → seconds = 90 → tParam = 0.75 → knobX), all in one shot.
    const BUTTON_W = 50;
    const BUTTON_H = 22;
    const buttonY = TIME_RAIL_Y + 24;
    let buttonX = TIME_RAIL_X1 - TIME_PRESETS.length * (BUTTON_W + 6) + 6;
    TIME_PRESETS.forEach(presetText => {
      const bx = buttonX;
      buttonX += BUTTON_W + 6;
      const button = s(
        rect(bx, buttonY, BUTTON_W, BUTTON_H, {
          fill: "#eaeaea",
          stroke: "#ccc",
          corner: 4,
        }),
      );
      s(
        label(vec(bx + BUTTON_W / 2, buttonY + BUTTON_H / 2 + 0.5), presetText, {
          size: 11,
          align: Anchor.Center,
          opacity: 0.85,
        }),
      );
      button.on("click", () => {
        time.value = presetText;
      });
      button.el.style.cursor = "pointer";
    });

    // Live param chip — shows seconds Num value too, to make the
    // bidirectional propagation visible across both signal worlds.
    s(
      label(
        vec(TIME_RAIL_X0, TIME_RAIL_Y - 12),
        computed(() => `seconds: ${seconds.value.toFixed(1)}s`),
        { size: 10, align: Anchor.Left, opacity: 0.55 },
      ),
      label(vec(TIME_RAIL_X0, TIME_RAIL_Y - 26), "secondsFromText(text)", {
        size: 10,
        align: Anchor.Left,
        opacity: 0.5,
      }),
    );
  }
}
