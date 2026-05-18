// WAAPI / scroll / viewport bridges. Scroll signals are lazy via the
// signal's `watched`/`unwatched` hooks; one shared capture-phase
// listener serves them all. Range names mirror CSS `view-timeline`.

import {suspend, type Animator} from "@minim/core";
import {signal, type Signal} from "@minim/signals";

/** WAAPI animation as a minim Animator. Bare-number `opts` is seconds;
 *  object `opts` passes through to `Element.animate` (ms). */
export function* native(
  el: Element,
  keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
  opts: number | KeyframeAnimationOptions = {},
): Animator<void> {
  const native = typeof opts === "number"
    ? { duration: opts * 1000 }
    : opts;
  const a = el.animate(keyframes, native);
  try {
    yield* untilAnimation(a);
    try { a.commitStyles(); } catch { /* disconnected or non-committable */ }
  } finally {
    a.cancel();
  }
}

/** Wake on the animation's `finish` event; resume with the event. */
export function untilAnimation(a: Animation): Animator<AnimationPlaybackEvent> {
  return suspend<AnimationPlaybackEvent>((wake) => {
    const handler = (e: Event): void => wake(e as AnimationPlaybackEvent);
    a.addEventListener("finish", handler, { once: true });
    return () => a.removeEventListener("finish", handler);
  });
}

/** Wake when `el` enters the viewport. Wakes immediately if already in. */
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

/** Wake when `el` leaves the viewport. Wakes immediately if already out. */
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

// Shared scroll plumbing: capture-phase picks up nested overflow
// containers (scroll doesn't bubble). `pageTotal` is cached and
// only refreshed on resize.

const subscribers = new Set<() => void>();
let rafId = 0;
let attached = false;
let pageTotal = 0;

function refreshPageTotal(): void {
  pageTotal = document.documentElement.scrollHeight - window.innerHeight;
}

function tick(): void {
  rafId = 0;
  // Snapshot: a callback may dispose another scroll signal mid-iter.
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

/** Global page scroll progress in `[0, 1]`; `0` if page doesn't scroll. */
export function scrollProgress(): Signal<number> {
  return scrollSignal(
    () => (pageTotal > 0 ? clamp01(window.scrollY / pageTotal) : 0),
    0,
  );
}

/** Slice of an element's viewport traversal mapped to `[0, 1]`. Names
 *  match CSS `view-timeline`:
 *    cover   leading enters ↦ trailing exits
 *    entry   leading enters ↦ fully in view
 *    contain fully in view (pinned at 0.5 when taller than vp)
 *    exit    starts exiting ↦ trailing exits */
export type ViewRange = "cover" | "entry" | "contain" | "exit";

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function rangeProgress(rect: DOMRect, vp: number, range: ViewRange): number {
  const top = rect.top;
  const h = rect.height;
  switch (range) {
    case "cover": {
      const total = vp + h;
      return total > 0 ? clamp01((vp - top) / total) : 0;
    }
    case "entry": {
      return h > 0 ? clamp01((vp - top) / h) : 1;
    }
    case "contain": {
      // Taller than vp: range doesn't exist — pin at 0.5 for stability.
      const total = vp - h;
      if (total <= 0) return 0.5;
      return clamp01((vp - h - top) / total);
    }
    case "exit": {
      return h > 0 ? clamp01(-top / h) : 1;
    }
  }
}

// Memoize `viewProgress` by (el, range) so N readers share one layout
// read per tick. WeakMap GCs when el is dropped.
const viewCache = new WeakMap<
  Element,
  Partial<Record<ViewRange, Signal<number>>>
>();

/** Element view-progress in `[0, 1]` over `range` (default `cover`). */
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

function elInViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return (
    r.bottom > 0 &&
    r.top < window.innerHeight &&
    r.right > 0 &&
    r.left < window.innerWidth
  );
}

/** Reactive boolean; `true` while `el` intersects the viewport. Seeded
 *  synchronously from rect, then maintained by IntersectionObserver. */
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
