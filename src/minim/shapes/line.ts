import { type Cell, derive, type Val, Vec } from "@minim/signals";
import { type CommonOpts, type Segment, Shape } from "./shape";

export interface LineOpts extends CommonOpts {}

export class Line<O extends LineOpts = LineOpts> extends Shape<O> {
  constructor(
    readonly from: Vec,
    readonly to: Vec,
    opts: O = {} as O,
  ) {
    super(
      opts.dashed ? "path" : "line",
      () => {
        const a = from.value;
        const b = to.value;
        return {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          w: Math.abs(b.x - a.x),
          h: Math.abs(b.y - a.y),
        };
      },
      opts,
      {
        origin: derive(() => {
          const a = from.value;
          const b = to.value;
          return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        }),
      },
    );
    this.attr("stroke-linecap", opts.cap ?? "round");
    this.stroke(opts, false, { x1: from.x, y1: from.y, x2: to.x, y2: to.y });
  }

  // Tangent/normal/angle are constant along a Line; `t` is accepted
  // for API symmetry with Path but ignored. Cached lazily.
  #tangent?: Vec;
  #normal?: Vec;
  #angle?: Cell<number>;
  #length?: Cell<number>;

  /** Position at fraction `t` (0=from, 1=to). Symmetric with
   *  `Path.pointAt`. */
  pointAt(t: Val<number>): Vec {
    if (typeof t === "number") {
      if (t === 0) return this.from;
      if (t === 1) return this.to;
    }
    return this.from.lerp(this.to, t);
  }

  tangentAt(_t: Val<number> = 0): Vec {
    return (this.#tangent ??= this.to.sub(this.from).normalize());
  }

  normalAt(_t: Val<number> = 0): Vec {
    return (this.#normal ??= this.tangentAt().perp());
  }

  angleAt(_t: Val<number> = 0): Cell<number> {
    if (this.#angle) return this.#angle;
    const tan = this.tangentAt();
    return (this.#angle = derive(() => Math.atan2(tan.y.value, tan.x.value)));
  }

  length(): Cell<number> {
    return (this.#length ??= derive(() => {
      const a = this.from.value;
      const b = this.to.value;
      return Math.hypot(b.x - a.x, b.y - a.y);
    }));
  }

  /** Closer endpoint to `toward`. */
  override boundary(toward: Vec): Vec {
    return Vec.derive(() => {
      const t = toward.value;
      const a = this.from.value;
      const b = this.to.value;
      const da = (t.x - a.x) ** 2 + (t.y - a.y) ** 2;
      const db = (t.x - b.x) ** 2 + (t.y - b.y) ** 2;
      return da <= db ? a : b;
    });
  }

  override segments(): Segment[] {
    return [{ type: "line", from: this.from.value, to: this.to.value }];
  }
}

export const line = <const O extends LineOpts>(from: Vec, to: Vec, opts?: O): Line<O> =>
  new Line<O>(from, to, opts);
