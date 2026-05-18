// minim/code — syntax-highlighted source as a reactive Shape with
// token-level morph transitions. Mirrors `minim/tex` in spirit:
//
//   code(src, { language, size })      → CodeShape (Shape with a
//                                          reactive `source` signal)
//   code.morphTo(target, dur)          → snapshot-diff morph; matched
//                                          tokens translate, added fade
//                                          in, removed fade out
//   codeStyles                         → CSS for Prism token classes
//                                          to drop into `Diagram.styles`
//
// What's deliberately absent for v1: per-token `part()` markers,
// editing API (replace / insert / remove), CSS Custom Highlights for
// run-trace overlays, anim-observer integration. Each is a layered
// addition on top of the same substrate.

export {CodeShape, code, codeStyles, TOKEN_CLASS, type CodeOpts} from "./code";
export {tokenize, type Token} from "./tokenize";
// `morph` itself is internal — accessed via `codeShape.morphTo(target, dur)`.
// The symbol name collides with `tex.morph`, and the method form composes
// just as well: `yield* race(c.morphTo(target, 0.4), stop)`.
