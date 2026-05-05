import { Shape } from "../shape";
import { Point } from "../point";
import { aabb } from "../bounds";
import { read, unwrap, type Arg } from "../signal";
import type { Segment } from "../dashed";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface AnnularSectorOpts extends CommonOpts {}

/** Pie wedge with a hole — the region between two radii (rOuter, rInner)
 *  swept between two angles (a0, a1). Useful for ring/dial diagrams. */
export class AnnularSector extends Shape {
  constructor(
    readonly center: Point,
    readonly rOuter: Arg<number>,
    readonly rInner: Arg<number>,
    readonly a0: Arg<number>,
    readonly a1: Arg<number>,
    opts: AnnularSectorOpts = {},
  ) {
    super(
      "path",
      () => {
        const ro = unwrap(rOuter);
        return aabb(center.x() - ro, center.y() - ro, 2 * ro, 2 * ro);
      },
      opts,
    );
    const ro = read(rOuter);
    const ri = read(rInner);
    const a0r = read(a0);
    const a1r = read(a1);

    if (!opts.dashed) {
      this.attr("d", () => {
        const cx = this.center.x();
        const cy = this.center.y();
        const _ro = ro();
        const _ri = ri();
        const _a0 = a0r();
        const _a1 = a1r();
        const span = Math.abs(_a1 - _a0);
        const largeArc = span > Math.PI ? 1 : 0;
        const sweep = _a1 > _a0 ? 1 : 0;
        const back = sweep ? 0 : 1;
        const o0x = cx + _ro * Math.cos(_a0), o0y = cy + _ro * Math.sin(_a0);
        const o1x = cx + _ro * Math.cos(_a1), o1y = cy + _ro * Math.sin(_a1);
        const i1x = cx + _ri * Math.cos(_a1), i1y = cy + _ri * Math.sin(_a1);
        const i0x = cx + _ri * Math.cos(_a0), i0y = cy + _ri * Math.sin(_a0);
        return `M ${o0x},${o0y} A ${_ro},${_ro} 0 ${largeArc} ${sweep} ${o1x},${o1y} L ${i1x},${i1y} A ${_ri},${_ri} 0 ${largeArc} ${back} ${i0x},${i0y} Z`;
      });
    }
    setupDashed(this, opts, true);
    applyOpts(this, opts);
  }

  override segments(): Segment[] {
    const cx = this.center.x;
    const cy = this.center.y;
    const ro = () => unwrap(this.rOuter);
    const ri = () => unwrap(this.rInner);
    const a0 = () => unwrap(this.a0);
    const a1 = () => unwrap(this.a1);
    const polar = (rfn: () => number, afn: () => number) =>
      new Point(
        () => cx() + rfn() * Math.cos(afn()),
        () => cy() + rfn() * Math.sin(afn()),
      );
    return [
      { type: "arc", cx, cy, r: ro, a0, a1 },
      { type: "line", from: polar(ro, a1), to: polar(ri, a1) },
      { type: "arc", cx, cy, r: ri, a0: a1, a1: a0 },
      { type: "line", from: polar(ri, a0), to: polar(ro, a0) },
    ];
  }
}

export const annularSector = (
  center: Point,
  rOuter: Arg<number>,
  rInner: Arg<number>,
  a0: Arg<number>,
  a1: Arg<number>,
  opts?: AnnularSectorOpts,
) => new AnnularSector(center, rOuter, rInner, a0, a1, opts);
