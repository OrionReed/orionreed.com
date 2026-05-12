// minim/tex — manim-style LaTeX primitives backed by Temml + MathML.
//
// One `tex\`…\`` template is one Shape (a foreignObject hosting
// browser-rendered MathML). Sub-formulas are addressable via
// `${part(name, content)}` interpolations: lightweight handles with a
// reactive `aabb` and a `highlighted` toggle. Decorations re-derive
// from that aabb; motion combinators (`write`, `writeParts`, `morph`)
// compose over the existing motion stdlib.

export { TexShape, tex, type TexInterp, type TexOpts } from "./tex";
export { Part, PartMarker, part, type PartList } from "./parts";
export {
  brace,
  box,
  underline,
  cross,
  type DecorationOpts,
} from "./decorations";
export {
  highlight,
  write,
  writeOut,
  writeParts,
  unwriteParts,
  morph,
  substitute,
} from "./motion";
