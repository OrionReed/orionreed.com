// Callable mount handle: `s(shape)` adds children under a root Shape;
// returns the child (or array, for vararg calls). Replaces the old
// `Scene` callable — the SVG-specific bits (`view`/`fit`/`svg`) now
// live on `Diagram` itself.
//
// Headless tests can construct one directly:
//
//     const root = new Shape();
//     const s = mount(root);
//     s(circle(...));

import type {AnyShape} from "./shape";

export interface Mount {
  <T extends AnyShape>(shape: T): T;
  <T extends AnyShape[]>(...shapes: T): T;
  readonly root: AnyShape;
}

export function mount(root: AnyShape): Mount {
  const fn = ((...shapes: AnyShape[]) => {
    for (const s of shapes) root.add(s);
    return shapes.length === 1 ? shapes[0] : shapes;
  }) as Mount;
  Object.defineProperty(fn, "root", { value: root });
  return fn;
}
