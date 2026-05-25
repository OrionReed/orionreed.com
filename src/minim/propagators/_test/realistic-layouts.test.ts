// realistic-layouts.test.ts — exercises that mirror what real
// applications need: nested layouts with multiple kinds of
// constraints (alignment, distribution, bounds, derived values).

import { describe, expect, it } from "vitest";
import { num } from "../../signals";
import { adder, align, aspectRatio, flexH, propagators, stack } from "..";

describe("realistic: app shell layout", () => {
  it("sidebar + main split with min/max sidebar", () => {
    // Common app shell: a sidebar with min/max bounds, main content
    // fills the rest. Drag the window: main resizes; sidebar clamps.
    const windowW = num(1024);
    const sidebarW = num(220);
    const mainW = num(0);
    const containerX = num(0);
    const sidebarX = num(0);
    const mainX = num(0);
    const gap = num(0);

    const p = propagators();
    p.add(
      flexH({
        containerX,
        containerWidth: windowW,
        gap,
        items: [
          { x: sidebarX, w: sidebarW, minW: 180, maxW: 320, grow: 0, shrink: 0 },
          { x: mainX, w: mainW, minW: 200, grow: 1 },
        ],
      }),
    );

    // Drag window to 1024.
    expect(sidebarW.value).toBe(220); // user-set, no grow, no shrink
    expect(mainW.value).toBe(1024 - 220);
    expect(mainX.value).toBe(220);

    // Window narrows.
    windowW.value = 600;
    expect(sidebarW.value).toBe(220);
    expect(mainW.value).toBe(600 - 220);

    // Window narrows further: would crush main below its min.
    windowW.value = 350;
    // Main wants 350-220 = 130; min is 200. main clamps at 200.
    expect(sidebarW.value).toBe(220);
    expect(mainW.value).toBe(200);
    // Total layout width = 420; window is 350. Overflow.

    p.dispose();
  });
});

describe("realistic: aligned columns with derived heights", () => {
  it("3 columns aligned vertically; total height computed", () => {
    // Three columns each with a header + body. Headers all top-
    // aligned, all same height (tallest header drives alignment).
    // Each column's total height = header.h + body.h. Container
    // height = max(column heights).
    const headerH1 = num(40);
    const headerH2 = num(60);
    const headerH3 = num(50);
    const bodyH1 = num(200);
    const bodyH2 = num(180);
    const bodyH3 = num(220);
    const colH1 = num(0);
    const colH2 = num(0);
    const colH3 = num(0);

    const p = propagators();
    // colH = headerH + bodyH per column.
    p.add(adder(headerH1, bodyH1, colH1));
    p.add(adder(headerH2, bodyH2, colH2));
    p.add(adder(headerH3, bodyH3, colH3));

    expect(colH1.value).toBe(240);
    expect(colH2.value).toBe(240);
    expect(colH3.value).toBe(270);

    // Drag a header.
    headerH1.value = 80;
    expect(colH1.value).toBe(280);

    // Drag a body.
    bodyH3.value = 100;
    expect(colH3.value).toBe(150);

    p.dispose();
  });

  it("synchronized header heights via align()", () => {
    // All three column headers should have the same height (visual
    // alignment). User drags one; the others follow.
    const h1 = num(40);
    const h2 = num(40);
    const h3 = num(40);

    const p = propagators();
    p.add(align(h1, h2, h3));

    // Initial fire: all already equal.
    expect(h1.value).toBe(40);
    expect(h2.value).toBe(40);
    expect(h3.value).toBe(40);

    // User resizes one.
    h2.value = 60;
    expect(h1.value).toBe(60);
    expect(h2.value).toBe(60);
    expect(h3.value).toBe(60);

    p.dispose();
  });
});

describe("realistic: image gallery with aspect-ratio + bounds", () => {
  it("16:9 thumbnails, fixed height, widths derive", () => {
    // Image gallery: each thumbnail has a 16:9 aspect ratio and a
    // fixed height. Width derives via aspect ratio.
    //
    // NOTE: aspectRatio(w, h, 16/9) is bidirectional. On initial
    // fire, prop1 runs first and overwrites the "driver" with the
    // computed value — see eq footgun in PROTOTYPE.md. Workaround
    // here: write the driver (h) explicitly AFTER install to seed
    // the network with the intended direction.
    const h = num(0);
    const w1 = num(0);
    const w2 = num(0);
    const w3 = num(0);

    const p = propagators();
    // 16:9 → w = h * (16/9).
    p.add(aspectRatio(w1, h, 16 / 9));
    p.add(aspectRatio(w2, h, 16 / 9));
    p.add(aspectRatio(w3, h, 16 / 9));

    h.value = 120; // drive h after install
    expect(w1.value).toBeCloseTo(120 * 16 / 9, 6);
    expect(w2.value).toBeCloseTo(120 * 16 / 9, 6);
    expect(w3.value).toBeCloseTo(120 * 16 / 9, 6);

    // Drag height: widths follow.
    h.value = 80;
    expect(w1.value).toBeCloseTo(80 * 16 / 9, 6);

    // Drag a width: height changes (aspectRatio is bidirectional);
    // other widths follow because they share `h`.
    w2.value = 320;
    expect(h.value).toBeCloseTo(180, 6); // 320 * 9/16
    // Other widths re-derive from h: w = h * 16/9 = 180 * 16/9 = 320.
    expect(w1.value).toBeCloseTo(320, 6);
    expect(w3.value).toBeCloseTo(320, 6);

    p.dispose();
  });
});

describe("realistic: form layout with label + input pairs", () => {
  it("inputs derive width from form/label/gap (one-direction)", () => {
    // Common form layout: rows of (label, input). All inputs share
    // a width that's `formW - labelW - gap`.
    //
    // For "slack is purely derived from drivers" we use a custom
    // ONE-DIRECTION propagator. Bidirectional `adder` would let any
    // input be the unknown, but that's not the intent — formW,
    // labelW, gap drive; slack and inputW* derive.
    const formW = num(400);
    const labelW = num(120);
    const gap = num(8);
    const inputW1 = num(0);
    const inputW2 = num(0);
    const inputW3 = num(0);

    const p = propagators();
    // slack = formW - labelW - gap, broadcast to all inputs.
    p.add({
      reads: [formW, labelW, gap],
      writes: [inputW1, inputW2, inputW3],
      step: () => {
        const slack = formW.value - labelW.value - gap.value;
        inputW1.value = slack;
        inputW2.value = slack;
        inputW3.value = slack;
      },
    });

    // 400 - 120 - 8 = 272.
    expect(inputW1.value).toBe(272);
    expect(inputW2.value).toBe(272);
    expect(inputW3.value).toBe(272);

    // Drag form wider.
    formW.value = 600;
    expect(inputW1.value).toBe(472);

    // Drag label wider.
    labelW.value = 200;
    expect(inputW1.value).toBe(392); // 600 - 200 - 8
    expect(inputW2.value).toBe(392);

    p.dispose();
  });
});

describe("realistic: nested splits (file-tree + editor + preview)", () => {
  it("3-pane IDE layout with all panes resizable", () => {
    // Like VS Code: file tree (left), editor (middle), preview
    // (right). Each has min width; the middle absorbs slack.
    const windowW = num(1280);
    const treeX = num(0);
    const editorX = num(0);
    const previewX = num(0);
    const treeW = num(240);
    const editorW = num(0);
    const previewW = num(320);
    const containerX = num(0);
    const gap = num(0);

    const p = propagators();
    p.add(
      flexH({
        containerX,
        containerWidth: windowW,
        gap,
        items: [
          { x: treeX, w: treeW, minW: 180, maxW: 400, grow: 0, shrink: 0 },
          { x: editorX, w: editorW, minW: 400, grow: 1 },
          { x: previewX, w: previewW, minW: 240, maxW: 500, grow: 0, shrink: 0 },
        ],
      }),
    );

    // editor = 1280 - 240 - 320 = 720.
    expect(treeW.value).toBe(240);
    expect(editorW.value).toBe(720);
    expect(previewW.value).toBe(320);
    expect(treeX.value).toBe(0);
    expect(editorX.value).toBe(240);
    expect(previewX.value).toBe(960);

    // User drags tree wider.
    treeW.value = 320;
    expect(editorW.value).toBe(640);
    expect(previewX.value).toBe(960);

    // Window resize: editor absorbs.
    windowW.value = 1600;
    expect(editorW.value).toBe(960);

    // Window narrows: editor shrinks toward min.
    windowW.value = 800;
    // tree=320, preview=320, gap=0; editor wants 800-640 = 160. min=400. clamps.
    expect(editorW.value).toBe(400);

    p.dispose();
  });
});
