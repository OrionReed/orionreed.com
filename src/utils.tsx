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

  const extend = 150;

  shapes.push({
    id: createShapeId(),
    type: 'geo',
    x: -extend,
    y: window.innerHeight,
    props: {
      w: window.innerWidth + (extend * 2),
      h: 50,
      color: 'grey',
      fill: 'solid'
    },
    meta: {
      fixed: true
    }
  });

  return shapes;
}