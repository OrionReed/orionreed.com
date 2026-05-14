import { computed, signal } from "@minim/signals";
import { Vec, type V } from "@minim/values";
import { bench, group } from "mitata";

// ── Lifted struct op (vec.add — arity 1, the per-arity-unrolled hot
//    path). Compares: framework-lifted method vs hand-written computed.

group("lifted struct op (vec.add) — eval cost", () => {
  // Dependencies fixed across iters so .value is cached after warmup.
  // Force re-eval via a fresh write each iter.
  const a: any = Vec.signal({ x: 1, y: 2 });
  const b = Vec.signal({ x: 3, y: 4 });
  void a.x;

  const sumLifted = a.add(b);
  const sumHand = computed(() => ({
    x: a.value.x + b.value.x,
    y: a.value.y + b.value.y,
  }));

  let i = 0;
  bench("write a.x → read sumLifted.value", () => {
    a.x.value = ++i;
    return sumLifted.value;
  }).baseline(true);
  bench("write a.x → read sumHand.value", () => {
    a.x.value = ++i;
    return sumHand.value;
  });
});

group("lifted struct op (vec.add) — construction (returns derived)", () => {
  const a = Vec.signal({ x: 1, y: 2 });
  const b = Vec.signal({ x: 3, y: 4 });

  bench("Vec a.add(b) [allocates derived]", () => a.add(b)).baseline(true);
  bench("hand: computed(() => add)", () =>
    computed(() => ({
      x: a.value.x + b.value.x,
      y: a.value.y + b.value.y,
    })),
  );
});

// ── Lifted scalar (vec.distance) ────────────────────────────────────

group("lifted scalar (vec.distance)", () => {
  const a: any = Vec.signal({ x: 1, y: 2 });
  const b = Vec.signal({ x: 4, y: 6 });
  void a.x;

  const distLifted = a.distance(b);
  const distHand = computed(() =>
    Math.hypot(a.value.x - b.value.x, a.value.y - b.value.y),
  );

  let i = 0;
  bench("write a.x → distLifted.value", () => {
    a.x.value = ++i;
    return distLifted.value;
  }).baseline(true);
  bench("write a.x → distHand.value", () => {
    a.x.value = ++i;
    return distHand.value;
  });
});

// ── Lifted op with reactive arg (signal-arg specialization) ─────────

group("lifted op — arg shapes (specialized at construction)", () => {
  const a: any = Vec.signal({ x: 1, y: 2 });
  void a.x;
  const literal: V = { x: 10, y: 20 };
  const sig = Vec.signal({ x: 10, y: 20 });
  const thunk = () => ({ x: 10, y: 20 });

  const dLit = a.add(literal);
  const dSig = a.add(sig);
  const dThk = a.add(thunk);

  let i = 0;
  bench("a.add(literal).value (closure: literal)", () => {
    a.x.value = ++i;
    return dLit.value;
  }).baseline(true);
  bench("a.add(sig).value (closure: signal-deref)", () => {
    a.x.value = ++i;
    return dSig.value;
  });
  bench("a.add(thunk).value (closure: thunk-call)", () => {
    a.x.value = ++i;
    return dThk.value;
  });
});

// ── Chain of lifted ops (closer to real-world derived chain) ────────

group("chained derived (a.add(b).scale(2).add(c))", () => {
  const a: any = Vec.signal({ x: 1, y: 2 });
  const b = Vec.signal({ x: 3, y: 4 });
  const c = Vec.signal({ x: 5, y: 6 });
  void a.x;

  const out = a.add(b).scale(2).add(c);

  const handOut = computed(() => {
    const av = a.value;
    const bv = b.value;
    const cv = c.value;
    return {
      x: (av.x + bv.x) * 2 + cv.x,
      y: (av.y + bv.y) * 2 + cv.y,
    };
  });

  let i = 0;
  bench("Vec lifted chain: write a.x → out.value", () => {
    a.x.value = ++i;
    return out.value;
  }).baseline(true);
  bench("Hand-merged computed: write a.x → handOut.value", () => {
    a.x.value = ++i;
    return handOut.value;
  });
});

// Suppress unused-import warning.
void signal;
