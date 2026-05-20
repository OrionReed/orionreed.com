// minim/code — monospace code substrate with reactive `Part` atoms.
//
//   code(src, { language, size })      → CodeShape — flat list of
//                                          absolutely-positioned parts
//                                          driven by a `source` signal.
//   c.parts                             → Part[] (single-line spans
//                                          with `position`, `opacity`,
//                                          `rotation` signals + `key`).
//   c.cut(part, [offsets])              → split a part on same row.
//   c.uncut([parts])                    → merge contiguous parts back.
//   c.group(key)                        → all parts sharing a key
//                                          (multi-line regions are
//                                          just multi-part groups).
//   c.morphTo(target, dur)              → animate from current source
//                                          to `target` via per-line
//                                          cross-fade + position tween.
//   codeStyles                          → ::highlight() colour rules
//                                          to drop in `Diagram.styles`.

export {CodeShape, code, codeStyles, Part, type CodeOpts} from "./code";
export {tokenize, type Token} from "./tokenize";
