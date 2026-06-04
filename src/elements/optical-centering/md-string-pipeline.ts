// md-string-pipeline.ts — bidirectional string editing through a chain
// of symmetric lenses.
//
// One source `str()` cell at the top; five projections beneath. Each
// pane is a writable view exposed via the engine's symmetric-lens
// primitive (`trim`, `lowercase`, `words`, `sortedUnique`) or a pure
// involution (`rot13`). Edit ANY pane and the source updates with the
// information the projection would normally lose preserved via the
// per-cell `complement`: padding, per-word case patterns, separator
// runs, duplicate source positions.
//
// Editing rules per pane:
//
//   Source        — plain writable cell, baseline.
//   Trimmed       — strip leading/trailing whitespace; writes restore
//                   the original padding via complement.
//   Lowercased    — lowercases each word; writes apply the SOURCE's
//                   per-word case pattern (all-caps / Title / lower)
//                   to the edited word at the same word index.
//   Words         — one word per line; writes restore the original
//                   separator pattern (spaces, tabs, punctuation).
//   Sorted Unique — alphabetised, case-insensitively unique; writes
//                   broadcast to every source occurrence with its
//                   original case preserved per-position.
//   ROT13         — pure involution; cipher in both directions.

import { effect, type Str, str, type Writable } from "../../minim";
import { BaseElement, css } from "../base-element";

const INITIAL = "  The Quick Brown Fox Jumps over the lazy dog.  ";

interface PaneSpec {
  name: string;
  kind: string;
  cell: Writable<Str>;
}

export class MdStringPipeline extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem 0;
      width: 100%;
      max-width: 720px;
      margin-left: auto;
      margin-right: auto;
      font-family: inherit;
      color: var(--text-color);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem;
    }
    @media (max-width: 600px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
    .pane {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      padding: 0.6rem 0.75rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-color);
    }
    .pane[data-source] {
      grid-column: 1 / -1;
      border-color: var(--text-color);
      border-width: 1px;
    }
    .pane header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 0.5rem;
    }
    .pane h3 {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 600;
    }
    .badge {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
      color: var(--text-secondary);
      padding: 0.05rem 0.4rem;
      background: var(--code-bg);
      border-radius: 3px;
      white-space: nowrap;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      line-height: 1.45;
      padding: 0.4rem 0.55rem;
      background: var(--code-bg);
      color: var(--code-text);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      resize: vertical;
      min-height: 3rem;
      white-space: pre;
      overflow: auto;
      tab-size: 2;
    }
    textarea:focus {
      outline: none;
      border-color: var(--text-color);
    }
    .pane[data-source] textarea {
      min-height: 4rem;
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0 0 0.6rem;
      line-height: 1.4;
    }
  `;

  #disposers: Array<() => void> = [];

  connectedCallback(): void {
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
  }

  protected render(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.shadow.replaceChildren();

    const source = str(INITIAL);
    const trimmed = source.trim();
    const lowered = trimmed.lowercase();
    const words = lowered.words();
    const unique = words.sortedUnique();
    const rot = source.rot13();

    // Realize each complement so the first read converges before any
    // user interaction.
    void trimmed.value;
    void lowered.value;
    void words.value;
    void unique.value;
    void rot.value;

    const panes: PaneSpec[] = [
      { name: "Source", kind: "writable cell", cell: source },
      { name: "Trimmed", kind: "symmetric · trim", cell: trimmed },
      { name: "Lowercased", kind: "symmetric · per-word case mask", cell: lowered },
      { name: "Words", kind: "symmetric · separator preservation", cell: words },
      { name: "Sorted Unique", kind: "symmetric · multi-position broadcast", cell: unique },
      { name: "ROT13", kind: "iso · involution", cell: rot },
    ];

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "Edit any pane — every other pane updates. Lossy projections recover what they discarded from each cell's complement: padding, case, separators, duplicate positions.";
    this.shadow.append(hint);

    const grid = document.createElement("div");
    grid.className = "grid";

    for (const p of panes) {
      const wrap = document.createElement("div");
      wrap.className = "pane";
      if (p.name === "Source") wrap.dataset.source = "true";

      const header = document.createElement("header");
      const h = document.createElement("h3");
      h.textContent = p.name;
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = p.kind;
      header.append(h, badge);
      wrap.append(header);

      const ta = document.createElement("textarea");
      ta.spellcheck = false;
      ta.autocapitalize = "off";
      ta.autocomplete = "off";
      ta.value = p.cell.value;
      ta.rows = p.name === "Source" ? 2 : 3;

      const onInput = () => {
        // User typed into this pane — write through. Editing through a
        // canonicalising projection (e.g. trim normalises trailing
        // spaces) shows up on next read; the cell's effect below skips
        // any pane the user is actively focused on so the cursor stays
        // put. We force a re-sync on blur to pick up the normalised
        // form.
        p.cell.value = ta.value;
      };
      ta.addEventListener("input", onInput);

      // On blur, re-sync the textarea to the cell's canonical value
      // (which may differ if the lens normalised the user's input —
      // e.g., typing "X" in the lowercase view is canonically "x").
      ta.addEventListener("blur", () => {
        const v = p.cell.value;
        if (ta.value !== v) ta.value = v;
      });

      wrap.append(ta);
      grid.append(wrap);

      // Bind cell → textarea. Skip the textarea the user is editing so
      // we never clobber the cursor; the blur handler above picks up
      // the canonical form when focus leaves.
      const dispose = effect(() => {
        const v = p.cell.value;
        if (this.shadow.activeElement === ta) return;
        if (ta.value !== v) ta.value = v;
      });
      this.#disposers.push(dispose);
    }

    this.shadow.append(grid);
  }
}
