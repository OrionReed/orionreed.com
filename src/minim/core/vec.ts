/** Plain 2D vector. The base value type for positions, sizes, and
 *  any pair of coordinates. Used at every layer; lives at the layer-B
 *  core so layout/scene types can depend on it without pulling in the
 *  scene graph. */
export interface Vec {
  x: number;
  y: number;
}
