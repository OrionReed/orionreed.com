// WAAPI / scroll / viewport bridges. Two surfaces, both lazy:
//
//   Awaitables — `yield* …` inside an animator; compose with race/endOn:
//     untilAnimation(a)        wake on Animation 'finish' (typed)
//     untilInView(el, opts?)   wake when `el` becomes intersecting
//     untilOutOfView(el, opts?) wake when `el` stops intersecting
//
//   Signals — read from anywhere reactive:
//     scrollProgress()         page-global [0, 1]
//     viewProgress(el, range)  view-timeline-style [0, 1]
//     inView(el, opts?)        Boolean visibility
//
// The scroll/view signals are lazy through the signal's `watched`/
// `unwatched` hooks: no scroll listener is attached until something
// actually reads them. One shared capture-phase listener serves every
// scroll/view signal; per-element IntersectionObservers are owned by
// their `inView` signal. Range names follow the CSS `view-timeline`
// spec (cover / entry / contain / exit) so semantics port over.

import {suspend, type Animator} from "@minim/core";
import {signal, type Signal} from "@minim/signals";

// ── Awaitables ──────────────────────────────────────────────────────

/** Wake on the WAAPI animation's `finish` event; resume with the
 *  event. Disposing the suspension removes the listener; the animation
 *  itself keeps running. Use a `finally` (or `endOn`) to cancel `a`
 *  if you want playback to stop alongside the generator. */
export function untilAnimation(a: Animation): Animator<AnimationPlaybackEvent> {
  return suspend<AnimationPlaybackEvent>((wake) => {
    const handler = (e: Event): void => wake(e as AnimationPlaybackEvent);
    a.addEventListener("finish", handler, { once: true });
    return () => a.removeEventListener("finish", handler);
  });
}

/** Wake when `el` enters the viewport (or hits the configured IO
 *  threshold). Wakes immediately if already intersecting — matches
 *  `untilTrue` semantics over a derived boolean. */
export function untilInView(
  el: Element,
  opts?: IntersectionObserverInit,
): Animator<void> {
  return suspend<void>((wake) => {
    let woke = false;
    const obs = new IntersectionObserver((entries) => {
      if (woke) return;
      if (entries.some((e) => e.isIntersecting)) {
        woke = true;
        wake();
      }
    }, opts);
    obs.observe(el);
    return () => obs.disconnect();
  });
}

/** Wake when `el` leaves the viewport. Wakes immediately if already
 *  out. Complement of `untilInView`. */
export function untilOutOfView(
  el: Element,
  opts?: IntersectionObserverInit,
): Animator<void> {
  return suspend<void>((wake) => {
    let woke = false;
    const obs = new IntersectionObserver((entries) => {
      if (woke) return;
      if (entries.some((e) => !e.isIntersecting)) {
        woke = true;
        wake();
      }
    }, opts);
    obs.observe(el);
    return () => obs.disconnect();
  });
}

// ── Shared scroll/resize plumbing ───────────────────────────────────
//
// All scroll/view signals share one capture-phase `scroll` + `resize`
// listener, rAF-coalesced. Capture phase picks up scrolls on nested
// overflow containers (the `scroll` event doesn't bubble), so signals
// stay live for elements inside scrollable parents.
//
// `pageTotal` (scrollable height) is cached and only refreshed on
// resize — it doesn't change on scroll. Slight staleness if the page
// grows from async content loads between resizes; `clamp01` on the
// reader side caps the visible effect to "fills slightly early."

const subscribers = new Set<() => void>();
let rafId = 0;
let attached = false;
let pageTotal = 0;

function refreshPageTotal(): void {
  pageTotal = document.documentElement.scrollHeight - window.innerHeight;
}

function tick(): void {
  rafId = 0;
  // Snapshot before iterating: a callback may dispose another scroll
  // signal (`unwatched` → `unwatchTick`), mutating the live set.
  const snapshot = [...subscribers];
  for (let i = 0; i < snapshot.length; i++) snapshot[i]();
}

function schedule(): void {
  if (rafId === 0) rafId = requestAnimationFrame(tick);
}

function onResize(): void {
  refreshPageTotal();
  schedule();
}

function attach(): void {
  if (attached) return;
  attached = true;
  refreshPageTotal();
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", onResize, { passive: true });
}

function detach(): void {
  if (!attached) return;
  attached = false;
  window.removeEventListener("scroll", schedule, { capture: true });
  window.removeEventListener("resize", onResize);
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function watchTick(cb: () => void): void {
  subscribers.add(cb);
  if (subscribers.size === 1) attach();
}

function unwatchTick(cb: () => void): void {
  subscribers.delete(cb);
  if (subscribers.size === 0) detach();
}

/** Lazy scroll-driven signal. `read()` runs on every scroll/resize
 *  (rAF-coalesced) only while the signal has subscribers. */
function scrollSignal<T>(read: () => T, initial: T): Signal<T> {
  let pull: (() => void) | undefined;
  const sig = signal<T>(initial, {
    watched() {
      pull = () => {
        sig.value = read();
      };
      watchTick(pull);
      pull();
    },
    unwatched() {
      if (pull) unwatchTick(pull);
      pull = undefined;
    },
  });
  return sig;
}

// ── Scroll signals ──────────────────────────────────────────────────

/** Global page scroll progress in `[0, 1]`. `0` at top, `1` at the
 *  bottom of the scrollable area; `0` when the page doesn't scroll.
 *  Uses the cached `pageTotal` — refreshed on resize, not on every
 *  scroll tick. */
export function scrollProgress(): Signal<number> {
  return scrollSignal(
    () => (pageTotal > 0 ? clamp01(window.scrollY / pageTotal) : 0),
    0,
  );
}

/** Which slice of the element's traversal through the viewport maps
 *  to `[0, 1]`. Names match the CSS `view-timeline` spec:
 *
 *    cover   leading edge enters ↦ trailing edge exits  (full traversal)
 *    entry   leading edge enters ↦ element fully in view
 *    contain element fully in view (pinned at 0.5 when taller than vp)
 *    exit    element starts exiting ↦ trailing edge exits */
export type ViewRange = "cover" | "entry" | "contain" | "exit";

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function rangeProgress(rect: DOMRect, vp: number, range: ViewRange): number {
  const top = rect.top;
  const h = rect.height;
  switch (range) {
    case "cover": {
      // Starts entering at top===vp, fully gone at top===-h.
      const total = vp + h;
      return total > 0 ? clamp01((vp - top) / total) : 0;
    }
    case "entry": {
      // Leading edge enters ↦ fully in view (rect.bottom===vp).
      return h > 0 ? clamp01((vp - top) / h) : 1;
    }
    case "contain": {
      // Fully entered ↦ about to exit. When taller than vp this range
      // doesn't exist; pin to 0.5 so dependents stay stable.
      const total = vp - h;
      if (total <= 0) return 0.5;
      return clamp01((vp - h - top) / total);
    }
    case "exit": {
      // Top edge at vp top ↦ bottom edge at vp top.
      return h > 0 ? clamp01(-top / h) : 1;
    }
  }
}

/** Element view-progress in `[0, 1]` over the given `range` (default
 *  `cover`). Tracks `getBoundingClientRect` against the viewport on
 *  every scroll/resize.
 *
 *  Memoized by `(el, range)` — repeat calls return the same signal,
 *  so N consumers share one layout read per tick. WeakMap entries
 *  are GC'd when `el` is dropped. */
const viewCache = new WeakMap<
  Element,
  Partial<Record<ViewRange, Signal<number>>>
>();

export function viewProgress(
  el: Element,
  range: ViewRange = "cover",
): Signal<number> {
  let entry = viewCache.get(el);
  if (!entry) viewCache.set(el, (entry = {}));
  return (entry[range] ??= scrollSignal(
    () => rangeProgress(el.getBoundingClientRect(), window.innerHeight, range),
    0,
  ));
}

// ── Visibility signal ───────────────────────────────────────────────

function elInViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return (
    r.bottom > 0 &&
    r.top < window.innerHeight &&
    r.right > 0 &&
    r.left < window.innerWidth
  );
}

/** Reactive boolean — `true` while `el` intersects the viewport. Backed
 *  by `IntersectionObserver`. The initial value is seeded from
 *  `getBoundingClientRect` so reads are correct before the observer's
 *  first async callback. */
export function inView(
  el: Element,
  opts?: IntersectionObserverInit,
): Signal<boolean> {
  let observer: IntersectionObserver | undefined;
  const sig = signal<boolean>(false, {
    watched() {
      sig.value = elInViewport(el);
      observer = new IntersectionObserver((entries) => {
        sig.value = entries.some((e) => e.isIntersecting);
      }, opts);
      observer.observe(el);
    },
    unwatched() {
      observer?.disconnect();
      observer = undefined;
    },
  });
  return sig;
}
