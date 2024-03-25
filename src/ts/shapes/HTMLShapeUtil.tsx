import { Rectangle2d, resizeBox, TLBaseShape, TLOnResizeHandler } from '@tldraw/tldraw';
import { HTMLContainer, ShapeUtil } from 'tldraw'

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

  override onResize: TLOnResizeHandler<any> = (shape, info) => {
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
    return <div dangerouslySetInnerHTML={{ __html: shape.props.html }}></div>

  }

  indicator(shape: HTMLShape) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}