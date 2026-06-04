// minim/code — monospace code substrate with reactive `Part` atoms.
//
//   code(src, opts)        → CodeShape (flat parts driven by `source`).
//   c.cut / c.uncut        → split / merge same-row parts.
//   c.group(key)           → parts sharing a key (multi-line region).
//   c.morphTo(target, dur) → per-line cross-fade + position tween.
//   codeStyles             → ::highlight() rules for `Diagram.styles`.

export { type CodeOpts, CodeShape, code, codeStyles, Part } from "./code";
export { type Token, tokenize } from "./tokenize";
