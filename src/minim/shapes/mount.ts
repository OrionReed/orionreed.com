// Callable mount handle: `s(shape)` adds children under a root Shape and returns them.

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
