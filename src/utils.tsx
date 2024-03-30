import { createShapeId } from "@tldraw/tldraw";

export function createShapes(elementsInfo: any) {
  const shapes = elementsInfo.map((element: any) => ({
    id: createShapeId(),
    type: 'html',
    x: element.x,
    y: element.y,
    props: {
      w: element.w,
      h: element.h,
      html: element.html,
    }
  }));
  return shapes;
}