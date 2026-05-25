// =====================================================================
// cluster.ts — uniform façade over closed-form point-cluster aggregates.
//
// The catalog of N→M aggregates (centroid, rotation, scale, bbox,
// bestFitLine, bestFitCircle, pcaLens, …) currently lives across
// several files with slightly different naming conventions. Discovering
// "I have points; what can I do with them?" requires reading three docs.
//
// `cluster(points)` puts everything under one navigation entry: lazy
// properties, one per aggregate, each returning the appropriate
// `Writable<…>` or record. Same backing primitives — same group-action
// semantics, same closed-form perf — just a uniform entry point.
//
// Example:
//
//   const c = cluster(points);
//   c.centroid.value = { x: 100, y: 0 };          // rigid translate
//   c.rotation.value = Math.PI / 4;               // rotate about centroid
//   c.scale.value = 2;                            // scale about centroid
//   c.bbox.size.value = { x: 200, y: 100 };       // axis-aligned resize
//   c.bestFitCircle.radius.value = 50;            // scale about mean
//   c.pca.majorLength.value = 30;                 // scale along major axis
//
// Same lazy() pattern as value-class field getters: one cell per
// property, memoised on first access, shared across all consumers.
// =====================================================================

import { lazy, type Read } from "../index";
import type { Num, Vec, Writable } from "../index";
import {
  bboxLens,
  procrustesLens,
} from "./factor-lens";
import {
  bestFitCircle,
  bestFitLine,
  pcaLens,
  rigidTranslate,
  rotateAbout,
  scaleAbout,
  scaleAboutXY,
} from "./closed-form-policies";

/** Facade exposing every closed-form aggregate over a point cluster.
 *  All properties are lazy: constructed on first access, memoised.
 *
 *  Optional `pivot`: by default, rotation/scale operate about the
 *  cluster's centroid. Pass a fixed point or another reactive Vec to
 *  rotate/scale about that instead. */
export interface Cluster {
  /** Writable centroid (rigid translate). */
  readonly centroid: Writable<Vec>;
  /** Writable rotation about pivot (default: centroid). */
  readonly rotation: Writable<Num>;
  /** Writable uniform scale about pivot (default: centroid). */
  readonly scale: Writable<Num>;
  /** Writable per-axis scale about pivot (default: centroid). */
  readonly scaleXY: Writable<Vec>;
  /** Axis-aligned bounding box. */
  readonly bbox: { center: Writable<Vec>; size: Writable<Vec> };
  /** Best-fit line through the cloud. */
  readonly bestFitLine: { point: Writable<Vec>; direction: Writable<Num> };
  /** Best-fit circle (mean center, mean radius). */
  readonly bestFitCircle: { center: Writable<Vec>; radius: Writable<Num> };
  /** PCA affine-similarity decomposition. */
  readonly pca: {
    mean: Writable<Vec>;
    rotation: Writable<Num>;
    majorLength: Writable<Num>;
    minorLength: Writable<Num>;
  };
  /** Similarity transform (translate + rotate + uniform scale about centroid). */
  readonly procrustes: {
    centroid: Writable<Vec>;
    rotation: Writable<Num>;
    scale: Writable<Num>;
  };
}

class ClusterImpl implements Cluster {
  // biome-ignore lint/suspicious/noExplicitAny: pivot is Read<V> or undefined
  constructor(
    private readonly points: readonly Writable<Vec>[],
    private readonly _pivot?: Read<{ x: number; y: number }>,
  ) {}

  private pivot(): Read<{ x: number; y: number }> {
    return this._pivot ?? this.centroid;
  }

  get centroid(): Writable<Vec> {
    return lazy(this, "centroid", () => rigidTranslate(this.points));
  }
  get rotation(): Writable<Num> {
    return lazy(this, "rotation", () => rotateAbout(this.points, this.pivot()));
  }
  get scale(): Writable<Num> {
    return lazy(this, "scale", () => scaleAbout(this.points, this.pivot()));
  }
  get scaleXY(): Writable<Vec> {
    return lazy(this, "scaleXY", () => scaleAboutXY(this.points, this.pivot()));
  }
  get bbox(): { center: Writable<Vec>; size: Writable<Vec> } {
    return lazy(this, "bbox", () => bboxLens(this.points));
  }
  get bestFitLine(): { point: Writable<Vec>; direction: Writable<Num> } {
    return lazy(this, "bestFitLine", () => bestFitLine(this.points));
  }
  get bestFitCircle(): { center: Writable<Vec>; radius: Writable<Num> } {
    return lazy(this, "bestFitCircle", () => bestFitCircle(this.points));
  }
  get pca() {
    return lazy(this, "pca", () => pcaLens(this.points));
  }
  get procrustes() {
    return lazy(this, "procrustes", () => procrustesLens(this.points));
  }
}

/** Uniform façade over a point cluster. See {@link Cluster}. */
export function cluster(
  points: readonly Writable<Vec>[],
  pivot?: Read<{ x: number; y: number }>,
): Cluster {
  return new ClusterImpl(points, pivot);
}
