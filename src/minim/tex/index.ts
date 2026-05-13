// minim/tex — manim-style LaTeX primitives backed by Temml + MathML.
//
// One `tex\`…\`` template is one Shape (a foreignObject hosting
// browser-rendered MathML). Sub-formulas are addressable via
// `${part(name, content)}` interpolations: lightweight handles with
// reactive `box`, `opacity`, `color`, `highlighted` signals.
// Decorations re-derive from `part.box`; motion combinators
// (`write`, `morph`, `pluck`/`unpluck`) compose over the existing
// motion stdlib. Per-part stagger is the standard `stagger`
// combinator from `motion/`:
//
//      for (const p of eq.parts) p.opacity.value = 0;
//      yield* stagger(0.1, eq.parts, p => p.opacity.to(1, 0.4));

export {
  TexShape,
  tex,
  type TexInterp,
  type TexOpts,
  type NamesOf,
} from "./tex";
export {
  Marker,
  Part,
  PartMarker,
  part,
  parts,
  tint,
  getMarker,
  type PartContent,
  type PartList,
} from "./parts";
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
  morph,
  pluck,
  unpluck,
  Plucked,
} from "./motion";
export { MdTex } from "./md-tex";
