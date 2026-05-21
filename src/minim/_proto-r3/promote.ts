// promote.ts — Writers interface (the shared writable surface) plus
// the public Writable<T> union and helpers.
//
// In this 3-class engine, "writable" is a primitive-level property:
// Signal<T> | Lens<T> have writable surface, Computed<T> doesn't.
// Value-class authors expose their own typed unions (e.g.
// `Vec = VecSignal | VecComputed | VecLens`, `WritableVec = VecSignal
// | VecLens`); no per-class Promote magic needed because the
// concrete classes carry writability via class identity.

import { Signal, Lens } from "./signal";

/** Anything you can write to via `.value = …`, `.set(...)`, `.bind(...)`. */
export type Writable<T = unknown> = Signal<T> | Lens<T>;
