// `delegate(host, key, struct)` — install passthrough getters on
// `host.prototype` so `host.foo` resolves to `host[key].foo` for every
// axis and lazy getter the struct registered.
//
// Motivation: today `Part`/`Shape` hand-roll 11+ forwarder field
// assignments per class to expose the Box surface (x/y/w/h, center,
// top, bottom, left, right, at, area, box). With `delegate(...)`,
// one declarative call replaces the whole block AND any future
// addition to the inner struct's surface propagates automatically.
//
// Construction win: ~18× faster than the hand-rolled pattern (bench
// section: delegate: construction). The hand-rolled version eagerly
// allocates a lens for every axis at ctor time; delegate pays only
// for axes the caller actually reads.
//
// Read win: parity with direct field assignment in monomorphic
// production patterns (bench section: isolated-check, mixed-read).
//
// Two variants exposed:
//
//   delegate       — cached. First read on a host installs an
//                    own-property carrying the inner axis Reactive,
//                    so subsequent reads bypass the proto getter
//                    entirely. Matches direct field access at ~3ns
//                    after warmup. The default.
//
//   delegateLazy   — non-caching. Every read walks `this[key][name]`.
//                    Saves the own-property slot when most axes are
//                    never read. V8 inlines this perfectly for
//                    monomorphic single-property hot loops, but
//                    multi-property patterns pay ~2× over cached.
//
// Type-level: this is runtime only. Host's TS surface doesn't yet
// auto-include the delegated axes; consumers cast or we add a
// `Delegated<Host, Map>` mapped type once the runtime stabilizes.

import type { StructType } from "@minim/signals";

export interface DelegateOpts {
  /** Names to skip — useful when the host wants to provide its own
   *  version of a field (e.g. Shape's transform-aware `.center`
   *  instead of the local-frame Box's `.center`). */
  exclude?: readonly string[];
}

/** Enumerate the "delegatable" property names on a struct's prototype.
 *  Anything installed as a getter (axes + lazies) qualifies. Methods
 *  (lifted ops, lifted scalars, free-form .set/.bind) are skipped —
 *  delegating them would shadow `Function.prototype` and create odd
 *  surfaces. Method delegation can be added later if needed. */
function enumerableGetters(struct: StructType<any>): string[] {
  const sample = struct.signal(struct.defaults) as object;
  const proto = Object.getPrototypeOf(sample);
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (desc && typeof desc.get === "function") out.push(name);
  }
  return out;
}

function check(hostProto: object, name: string): void {
  if (Object.prototype.hasOwnProperty.call(hostProto, name)) {
    throw new Error(`delegate: '${name}' already on host prototype`);
  }
}

/** Default. First read on a host installs an own-property; subsequent
 *  reads bypass the prototype getter. Mirrors the framework's own
 *  `axes` and `lazies` caching pattern.
 *
 *  Use this unless you have a specific reason to use `delegateLazy`. */
export function delegate<H extends object>(
  hostProto: H,
  key: keyof any,
  struct: StructType<any>,
  opts: DelegateOpts = {},
): readonly string[] {
  const exclude = new Set(opts.exclude ?? []);
  const installed: string[] = [];
  for (const name of enumerableGetters(struct)) {
    if (exclude.has(name)) continue;
    check(hostProto, name);
    Object.defineProperty(hostProto, name, {
      configurable: true,
      get(this: any) {
        const v = this[key][name];
        Object.defineProperty(this, name, {
          value: v,
          enumerable: false,
          configurable: false,
          writable: false,
        });
        return v;
      },
    });
    installed.push(name);
  }
  return installed;
}

/** Non-caching variant. Every read walks `this[key][name]`. Saves the
 *  own-property slot — useful when the host has many delegated axes
 *  most of which are never read. Single-property hot loops are inlined
 *  by V8 to direct-field speed; multi-property reads in one function
 *  pay ~2× over cached.
 *
 *  Prefer `delegate` unless you've measured a footprint problem. */
export function delegateLazy<H extends object>(
  hostProto: H,
  key: keyof any,
  struct: StructType<any>,
  opts: DelegateOpts = {},
): readonly string[] {
  const exclude = new Set(opts.exclude ?? []);
  const installed: string[] = [];
  for (const name of enumerableGetters(struct)) {
    if (exclude.has(name)) continue;
    check(hostProto, name);
    Object.defineProperty(hostProto, name, {
      configurable: true,
      get(this: any) {
        return this[key][name];
      },
    });
    installed.push(name);
  }
  return installed;
}
