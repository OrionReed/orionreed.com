import { Shape } from "../shape";
import { Point } from "../point";
import { aabb } from "../bounds";
import { computed, toSig, type Arg, type Signal, type ReadonlySignal } from "../signal";
import type { Segment } from "../dashed";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface AnnularSectorOpts extends CommonOpts {}

type NumSig = Signal<number> | ReadonlySignal<number>;

/** Pie wedge with a hole — the region between two radii (rOuter, rInner)
 *  swept between two angles (a0, a1). Useful for ring/dial diagrams. */
export class AnnularSector extends Shape {
  readonly rOuter: NumSig;
  readonly rInner: NumSig;
  readonly a0: NumSig;
  readonly a1: NumSig;

  constructor(
    readonly center: Point,
    rOuter: Arg<number>,
    rInner: Arg<number>,
    a0: Arg<number>,
    a1: Arg<number>,
    opts: AnnularSectorOpts = {},
  ) {
    const ro = toSig(rOuter);
    const ri = toSig(rInner);
    const a0s = toSig(a0);
    const a1s = toSig(a1);
    super(
      "path",
      () =>
        aabb(center.x.value - ro.value, center.y.value - ro.value, 2 * ro.value, 2 * ro.value),
      opts,
    );
    this.rOuter = ro;
    this.rInner = ri;
    this.a0 = a0s;
    this.a1 = a1s;

    if (!opts.dashed) {
      this.attr(
        "d",
        computed(() => {
          const cx = center.x.value;
          const cy = center.y.value;
          const _ro = ro.value;
          const _ri = ri.value;
          const _a0 = a0s.value;
          const _a1 = a1s.value;
          const span = Math.abs(_a1 - _a0);
          const largeArc = span > Math.PI ? 1 : 0;
          const sweep = _a1 > _a0 ? 1 : 0;
          const back = sweep ? 0 : 1;
          const o0x = cx + _ro * Math.cos(_a0), o0y = cy + _ro * Math.sin(_a0);
          const o1x = cx + _ro * Math.cos(_a1), o1y = cy + _ro * Math.sin(_a1);
          const i1x = cx + _ri * Math.cos(_a1), i1y = cy + _ri * Math.sin(_a1);
          const i0x = cx + _ri * Math.cos(_a0), i0y = cy + _ri * Math.sin(_a0);
          return `M ${o0x},${o0y} A ${_ro},${_ro} 0 ${largeArc} ${sweep} ${o1x},${o1y} L ${i1x},${i1y} A ${_ri},${_ri} 0 ${largeArc} ${back} ${i0x},${i0y} Z`;
        }),
      );
    }
    setupDashed(this, opts, true);
    applyOpts(this, opts);
  }

  override segments(): Segment[] {
    const cx = () => this.center.x.value;
    const cy = () => this.center.y.value;
    const ro = () => this.rOuter.value;
    const ri = () => this.rInner.value;
    const a0 = () => this.a0.value;
    const a1 = () => this.a1.value;
    const polar = (rfn: () => number, afn: () => number) =>
      new Point(
        computed(() => cx() + rfn() * Math.cos(afn())),
        computed(() => cy() + rfn() * Math.sin(afn())),
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
