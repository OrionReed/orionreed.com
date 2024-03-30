import { Rectangle2d, resizeBox, TLBaseShape, TLOnBeforeUpdateHandler, TLOnResizeHandler } from '@tldraw/tldraw';
import { ShapeUtil } from 'tldraw'

export type HTMLShape = TLBaseShape<'html', { w: number; h: number, html: string }>

export class HTMLShapeUtil extends ShapeUtil<HTMLShape> {
  static override type = 'html' as const
  override canBind = () => true
  override canEdit = () => false
  override canResize = () => true
  override isAspectRatioLocked = () => false

  getDefaultProps(): HTMLShape['props'] {
    return {
      w: 100,
      h: 100,
      html: "<div></div>"
    }
  }

  override onTranslate: TLOnBeforeUpdateHandler<HTMLShape> = (prev, next) => {
    if (prev.x !== next.x || prev.y !== next.y) {
      this.editor.bringToFront([next.id]);
    }
  }

  override onResize: TLOnResizeHandler<HTMLShape> = (shape: HTMLShape, info) => {
    const element = document.getElementById(shape.id);
    if (!element || !element.parentElement) return resizeBox(shape, info);
    const { width, height } = element.parentElement.getBoundingClientRect();
    if (element) {
      const isOverflowing = element.scrollWidth > width || element.scrollHeight > height;
      if (isOverflowing) {
        element.parentElement?.classList.add('overflowing');
      } else {
        element.parentElement?.classList.remove('overflowing');
      }
    }
    return resizeBox(shape, info)
  }

  getGeometry(shape: HTMLShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    })
  }

  component(shape: HTMLShape) {
    return <div id={shape.id} dangerouslySetInnerHTML={{ __html: shape.props.html }} />

  }

  indicator(shape: HTMLShape) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}