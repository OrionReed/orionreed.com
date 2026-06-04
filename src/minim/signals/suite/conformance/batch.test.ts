// Batched view writes — single-parent lenses are write-through inside a
// batch. The old engine deferred a view's backward write to flush and
// compared the incoming value against the COMMITTED source, so a revert
// looked like a no-op and was dropped, and a view didn't read back its
// own pending write. A single-parent lens now runs the backward walk
// eagerly: `_writeSource` stages the source (Dirty + pending) and defers
// only the flush, so the source's pending value gives last-write-wins
// and write-then-read consistency without a queue.

import { describe, expect, it } from "vitest";
import { minim } from "../adapters/minim";

const identityView = (init: number) => {
  const source = minim.signal(init);
  const view = minim.lens(
    source,
    x => x,
    nv => nv,
  );
  return { source, view };
};

describe("batched view writes", () => {
  it("last write wins when the final value differs from baseline", () => {
    const { source, view } = identityView(0);
    minim.batch(() => {
      view.write(5);
      view.write(9);
    });
    expect(source.read()).toBe(9);
  });

  it("a revert to the pre-batch value lands (write 5 then 0 ⇒ source 0)", () => {
    const { source, view } = identityView(0);
    minim.batch(() => {
      view.write(5);
      view.write(0);
    });
    expect(source.read()).toBe(0);
  });

  it("a view is write-then-read consistent inside a batch", () => {
    const { view } = identityView(0);
    let seen = Number.NaN;
    minim.batch(() => {
      view.write(7);
      seen = view.read();
    });
    expect(seen).toBe(7);
  });
});
