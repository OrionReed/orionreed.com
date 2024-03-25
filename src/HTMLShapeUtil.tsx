import { Rectangle2d, TLBaseShape } from '@tldraw/tldraw';
import { HTMLContainer, ShapeUtil } from 'tldraw'

export type HTMLShape = TLBaseShape<'html', { w: number; h: number, html: string }>

export class HTMLShapeUtil extends ShapeUtil<HTMLShape> {
  static override type = 'html' as const

  getDefaultProps(): HTMLShape['props'] {
    return {
      w: 100,
      h: 100,
      html: "<div></div>"
    }
  }

  getGeometry(shape: IHTMLShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    })
  }

  component(shape: HTMLShape) {
    return <div dangerouslySetInnerHTML={{ __html: shape.props.html }} style={{ margin: 0 }} ></div>
  }

  indicator(shape: HTMLShape) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}