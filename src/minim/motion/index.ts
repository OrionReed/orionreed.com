// Re-exports for convenience. After the restructure, prefer importing
// from the canonical homes:
//   - easings, clocks      → `@minim/core`
//   - behaviors            → `@minim/values`
//   - transitions, choreographers → `@minim/shapes`
export { linear, easeOut, easeIn, easeInOut } from "@minim/core";
export {
  spring,
  oscillate,
  drift,
  attract,
  type SpringOpts,
} from "./behaviors";
export {
  from,
  fadeIn,
  fadeOut,
  fadeUp,
  fadeUpOut,
  slideIn,
  slideOut,
  scaleIn,
  zoomOut,
  bounceIn,
  spinIn,
} from "./transitions";
export { pulse, every } from "@minim/core";
export { swap, stagger, splay, assemble, orbit } from "./choreographers";
