// md-tri-tree.ts — nested checkbox tree with three-valued aggregates.
//
// Every leaf is a `bool()` cell; every folder is `Tri.allOf([…leaves])`
// — a writable Tri aggregate over its descendant leaves. The folder is
// JUST another reactive cell: the same engine, the same `.value`
// surface, the same click-to-toggle semantics. No recursive walks in
// the rendering tree, no useEffect / refs for the indeterminate flag,
// no manual cascade logic. The recursion lives in the data structure;
// the cascade falls out of the broadcast policy in `Tri.allOf`'s bwd.
//
// Each `<input type="checkbox">` is bound to a cell via an effect:
//   - `checkbox.checked` ← `cell.value === true`
//   - `checkbox.indeterminate` ← `cell.value === "mixed"`
//   - `checkbox.onchange` → `cell.value = checkbox.checked`
//
// The write semantics are identical for leaves (writable Bool) and
// folders (writable Tri). The Tri aggregate's `putl` cascades the new
// `true`/`false` to every descendant leaf in one batched propagation.

import { type Bool, bool, effect, Num, Tri, type Writable } from "../../minim";
import { BaseElement, css } from "../base-element";

interface Leaf {
  kind: "leaf";
  label: string;
  checked: Writable<Bool>;
}
interface Folder {
  kind: "folder";
  label: string;
  children: Node[];
  checked: Writable<Tri>;
}
type Node = Leaf | Folder;

const leaf = (label: string, initial = false): Leaf => ({
  kind: "leaf",
  label,
  checked: bool(initial),
});

const folder = (label: string, children: Node[]): Folder => {
  const leaves = collectLeaves(children);
  return {
    kind: "folder",
    label,
    children,
    checked: Tri.allOf(leaves),
  };
};

function collectLeaves(nodes: Node[]): Writable<Bool>[] {
  const out: Writable<Bool>[] = [];
  for (const n of nodes) {
    if (n.kind === "leaf") out.push(n.checked);
    else out.push(...collectLeaves(n.children));
  }
  return out;
}

export class MdTriTree extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      width: 100%;
      max-width: 640px;
      font-family: inherit;
      color: var(--text-color);
    }
    .wrap {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 1.25rem;
      align-items: start;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-color);
    }
    @media (max-width: 540px) {
      .wrap {
        grid-template-columns: 1fr;
      }
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    ul ul {
      padding-left: 1.5rem;
    }
    li {
      padding: 0.15rem 0;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      font-size: 0.95rem;
    }
    .row.folder > .label {
      font-weight: 600;
    }
    .row.leaf > .label {
      font-weight: 400;
    }
    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--ink-fill, #5b8def);
      margin: 0;
    }
    .label {
      cursor: pointer;
      user-select: none;
      transition: opacity 0.15s ease;
    }
    .row.leaf:has(input[type="checkbox"]:checked) > .label {
      text-decoration: line-through;
      opacity: 0.55;
    }
    .stats {
      align-self: stretch;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.6rem 0.75rem;
      background: var(--code-bg);
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8rem;
      color: var(--text-secondary);
      min-width: 130px;
    }
    .stats .progress {
      height: 6px;
      background: var(--border-color);
      border-radius: 3px;
      overflow: hidden;
    }
    .stats .bar {
      height: 100%;
      background: var(--ink-fill, #5b8def);
      transition: width 0.15s ease;
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0.4rem 0 0.6rem;
    }
  `;

  #disposers: Array<() => void> = [];

  disconnectedCallback(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
  }

  protected render(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.shadow.replaceChildren();

    // ─── Tree data ────────────────────────────────────────────────
    const tree = folder("Tasks", [
      folder("Work", [
        leaf("Write quarterly report"),
        leaf("Review pull request", true),
        leaf("Reply to client email"),
      ]),
      folder("Personal", [leaf("Buy groceries"), leaf("Call mom", true), leaf("Do laundry")]),
      folder("Reading", [leaf("Finish chapter 4", true), leaf("Take notes on chapter 5", true)]),
    ]);

    const allLeaves = collectLeaves([tree]);
    // Total / checked counters via Num.derive — same engine, just
    // another aggregate of the leaf bools.
    const total = allLeaves.length;
    const checkedCount = Num.derive(() => allLeaves.filter(b => b.value).length);

    // ─── DOM scaffold ─────────────────────────────────────────────
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "Click any checkbox. Folders are Tri.allOf(descendants) — clicking cascades; partial states show indeterminate.";
    this.shadow.append(hint);

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.append(this.#renderTree(tree));
    wrap.append(this.#renderStats(checkedCount, total));
    this.shadow.append(wrap);
  }

  #renderTree(root: Node): HTMLElement {
    const ul = document.createElement("ul");
    ul.append(this.#renderNode(root));
    return ul;
  }

  #renderNode(node: Node): HTMLLIElement {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = `row ${node.kind}`;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = node.label;
    row.append(cb, label);
    li.append(row);

    // Unified cell ↔ checkbox binding. Bool's `value` is `boolean`;
    // Tri's is `boolean | "mixed"`. The same effect handles both —
    // `v === "mixed"` is `false` for plain booleans, so the
    // `indeterminate` line is a harmless no-op on leaves. Writes go
    // out as `boolean` either way; for Tri that's a valid subset of
    // its domain and triggers the broadcast policy in its bwd.
    const cell = node.checked as Writable<Tri>;
    const dispose = effect(() => {
      const v = cell.value;
      cb.checked = v === true;
      cb.indeterminate = v === "mixed";
    });
    this.#disposers.push(dispose);
    cb.addEventListener("change", () => {
      cell.value = cb.checked;
    });
    label.addEventListener("click", () => {
      // mixed / false → true; true → false. Same as native click on
      // an indeterminate checkbox.
      cell.value = cell.peek() === true ? false : true;
    });

    if (node.kind === "folder") {
      const childUl = document.createElement("ul");
      for (const child of node.children) {
        childUl.append(this.#renderNode(child));
      }
      li.append(childUl);
    }
    return li;
  }

  #renderStats(checked: Num, total: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "stats";

    const countLine = document.createElement("div");
    const remainingLine = document.createElement("div");
    const percentLine = document.createElement("div");
    const progress = document.createElement("div");
    progress.className = "progress";
    const bar = document.createElement("div");
    bar.className = "bar";
    progress.append(bar);

    const dispose = effect(() => {
      const c = checked.value;
      const pct = total > 0 ? (c / total) * 100 : 0;
      countLine.textContent = `${c} / ${total} checked`;
      remainingLine.textContent = `${total - c} remaining`;
      percentLine.textContent = `${pct.toFixed(0)}% complete`;
      bar.style.width = `${pct}%`;
    });
    this.#disposers.push(dispose);

    wrap.append(countLine, remainingLine, progress, percentLine);
    return wrap;
  }
}
