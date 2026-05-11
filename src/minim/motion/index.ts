export { linear, easeOut, easeIn, easeInOut } from "./easings";
export { all, sequence, delay, until, rand } from "./compose";
export {
  spring,
  oscillate,
  drift,
  attract,
  type SpringOpts,
} from "./behaviors";
export {
  // primitive — the pose-then-tween every intro is built from
  from,
  // atoms
  fadeIn,
  fadeOut,
  // compounds (visible compositions of `from` and `.to`)
  fadeUp,
  fadeUpOut,
  slideIn,
  slideOut,
  scaleIn,
  zoomOut,
  bounceIn,
  spinIn,
  // direction vectors for slideIn/slideOut
  Dir,
} from "./transitions";
export { pulse, clock, every, ramp, reverse, speed } from "./clocks";
export {
  swap,
  stagger,
  splay,
  orbit,
  assemble,
} from "./choreographers";
