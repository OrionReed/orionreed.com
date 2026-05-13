import { computed, toSig, type Arg, type NumSig } from "../core";
import {
  Shape,
  Vec,
  type Pointlike,
  type Segment,
} from "../scene";
import { box } from "../signals/box";
import { wireStroke, type CommonOpts } from "./common";

export interface AnnularSectorOpts extends CommonOpts {}

/** Pie wedge with a hole — between two radii swept across two angles. */
export class AnnularSector<
  O extends AnnularSectorOpts = AnnularSectorOpts,
> extends Shape<O> {
  readonly rOuter: NumSig;
  readonly rInner: NumSig;
  readonly a0: NumSig;
  readonly a1: NumSig;

  constructor(
    center: Pointlike,
    rOuter: Arg<number>,
    rInner: Arg<number>,
    a0: Arg<number>,
    a1: Arg<number>,
    opts: O = {} as O,
  ) {
    const ro = toSig(rOuter);
    const ri = toSig(rInner);
    const a0s = toSig(a0);
    const a1s = toSig(a1);
    super(
      "path",
      () =>
        box(
          center.x.value - ro.value,
          center.y.value - ro.value,
          2 * ro.value,
          2 * ro.value,
        ),
      opts,
      { origin: () => center.value },
    );
    this.rOuter = ro;
    this.rInner = ri;
    this.a0 = a0s;
    this.a1 = a1s;

    wireStroke(this, opts, true, () => {
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
          const o0x = cx + _ro * Math.cos(_a0),
            o0y = cy + _ro * Math.sin(_a0);
          const o1x = cx + _ro * Math.cos(_a1),
            o1y = cy + _ro * Math.sin(_a1);
          const i1x = cx + _ri * Math.cos(_a1),
            i1y = cy + _ri * Math.sin(_a1);
          const i0x = cx + _ri * Math.cos(_a0),
            i0y = cy + _ri * Math.sin(_a0);
          return `M ${o0x},${o0y} A ${_ro},${_ro} 0 ${largeArc} ${sweep} ${o1x},${o1y} L ${i1x},${i1y} A ${_ri},${_ri} 0 ${largeArc} ${back} ${i0x},${i0y} Z`;
        }),
      );
    });
  }

  /** Rendered inside the shape's own `<g transform>` so coords are
   *  local-frame — derived from the Box (whose center matches the
   *  user-supplied center). */
  override segments(): Segment[] {
    const cx = () => this.box.value.x + this.box.value.w / 2;
    const cy = () => this.box.value.y + this.box.value.h / 2;
    const ro = () => this.rOuter.value;
    const ri = () => this.rInner.value;
    const a0 = () => this.a0.value;
    const a1 = () => this.a1.value;
    const polar = (rfn: () => number, afn: () => number) =>
      Vec.derived(() => ({
        x: cx() + rfn() * Math.cos(afn()),
        y: cy() + rfn() * Math.sin(afn()),
      }));
    return [
      { type: "arc", cx, cy, r: ro, a0, a1 },
      { type: "line", from: polar(ro, a1), to: polar(ri, a1) },
      { type: "arc", cx, cy, r: ri, a0: a1, a1: a0 },
      { type: "line", from: polar(ri, a0), to: polar(ro, a0) },
    ];
  }
}

export const annularSector = <const O extends AnnularSectorOpts>(
  center: Pointlike,
  rOuter: Arg<number>,
  rInner: Arg<number>,
  a0: Arg<number>,
  a1: Arg<number>,
  opts?: O,
): AnnularSector<O> =>
  new AnnularSector<O>(center, rOuter, rInner, a0, a1, opts);
