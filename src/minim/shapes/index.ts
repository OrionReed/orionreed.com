export { applyOpts, setupDashed, type CommonOpts } from "./common";
export { Line, line, type LineOpts } from "./line";
export { Circle, circle, type CircleOpts } from "./circle";
export { Rect, rect, type RectOpts } from "./rect";
export { Label, label, type LabelOpts } from "./label";
export { group } from "./group";
export { Path, PathBuilder, path, type PathOpts } from "./path";
export { AnnularSector, annularSector, type AnnularSectorOpts } from "./annular-sector";
export { connect, arrow, ensureArrowMarker, type ArrowOpts } from "./connect";
export { clipPath } from "./clip";

// Shape-internal utilities (algorithms + visual primitives).
export { dashedPath } from "./dashed";
export { tokens, type Tokens } from "./tokens";
export { Text, t, type Content, type TextPart } from "./text";
export { align, arrange, type ArrangeOpts } from "./layout";
export { forEach, type ForEachOptions } from "./list";
