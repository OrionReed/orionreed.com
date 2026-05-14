// Vendored from alien-signals v3.2.1 — MIT licensed.
// https://github.com/stackblitz/alien-signals
//
// The mark-and-sweep reactive system. Same algorithm as preact-signals
// version-counter approach, but with a linked-list dep graph and a
// queue-based effect scheduler that's ~30% faster on common patterns.
//
// Only minor changes from upstream:
//   - typed everything (vendored .mjs is plain JS; we widen back to TS)
//   - removed const-enum (used plain object) for tsc compat
//   - exported `ReactiveFlags` values for engine code to use

export interface ReactiveNode {
  deps?: Link;
  depsTail?: Link;
  subs?: Link;
  subsTail?: Link;
  flags: number;
}

export interface Link {
  version: number;
  dep: ReactiveNode;
  sub: ReactiveNode;
  prevSub: Link | undefined;
  nextSub: Link | undefined;
  prevDep: Link | undefined;
  nextDep: Link | undefined;
}

interface Stack<T> {
  value: T;
  prev: Stack<T> | undefined;
}

export const ReactiveFlags = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
} as const;

export function createReactiveSystem({
  update,
  notify,
  unwatched,
}: {
  update(sub: ReactiveNode): boolean;
  notify(sub: ReactiveNode): void;
  unwatched(sub: ReactiveNode): void;
}) {
  return { link, unlink, propagate, checkDirty, shallowPropagate };

  function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
    const prevDep = sub.depsTail;
    if (prevDep !== undefined && prevDep.dep === dep) return;
    const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps;
    if (nextDep !== undefined && nextDep.dep === dep) {
      nextDep.version = version;
      sub.depsTail = nextDep;
      return;
    }
    const prevSub = dep.subsTail;
    if (prevSub !== undefined && prevSub.version === version && prevSub.sub === sub) return;
    const newLink: Link = (sub.depsTail = dep.subsTail = {
      version, dep, sub, prevDep, nextDep, prevSub, nextSub: undefined,
    });
    if (nextDep !== undefined) nextDep.prevDep = newLink;
    if (prevDep !== undefined) prevDep.nextDep = newLink;
    else sub.deps = newLink;
    if (prevSub !== undefined) prevSub.nextSub = newLink;
    else dep.subs = newLink;
  }

  function unlink(link: Link, sub: ReactiveNode = link.sub): Link | undefined {
    const { dep, prevDep, nextDep, nextSub, prevSub } = link;
    if (nextDep !== undefined) nextDep.prevDep = prevDep;
    else sub.depsTail = prevDep;
    if (prevDep !== undefined) prevDep.nextDep = nextDep;
    else sub.deps = nextDep;
    if (nextSub !== undefined) nextSub.prevSub = prevSub;
    else dep.subsTail = prevSub;
    if (prevSub !== undefined) prevSub.nextSub = nextSub;
    else if ((dep.subs = nextSub) === undefined) unwatched(dep);
    return nextDep;
  }

  function propagate(link: Link, innerWrite: boolean): void {
    let next: Link | undefined = link.nextSub;
    let stack: Stack<Link | undefined> | undefined;
    top: do {
      const sub = link.sub;
      let flags = sub.flags;
      if (!(flags & (4 | 8 | 16 | 32))) {
        sub.flags = flags | 32;
        if (innerWrite) sub.flags |= 8;
      } else if (!(flags & (4 | 8))) {
        flags = 0;
      } else if (!(flags & 4)) {
        sub.flags = (flags & ~8) | 32;
      } else if (!(flags & (16 | 32)) && isValidLink(link, sub)) {
        sub.flags = flags | (8 | 32);
        flags &= 1;
      } else {
        flags = 0;
      }
      if (flags & 2) notify(sub);
      if (flags & 1) {
        const subSubs = sub.subs;
        if (subSubs !== undefined) {
          const nextSub = (link = subSubs).nextSub;
          if (nextSub !== undefined) {
            stack = { value: next, prev: stack };
            next = nextSub;
          }
          continue;
        }
      }
      if ((link = next!) !== undefined) {
        next = link.nextSub;
        continue;
      }
      while (stack !== undefined) {
        link = stack.value!;
        stack = stack.prev;
        if (link !== undefined) {
          next = link.nextSub;
          continue top;
        }
      }
      break;
    } while (true);
  }

  function checkDirty(link: Link, sub: ReactiveNode): boolean {
    let stack: Stack<Link> | undefined;
    let checkDepth = 0;
    let dirty = false;
    top: do {
      const dep = link.dep;
      const flags = dep.flags;
      if (sub.flags & 16) dirty = true;
      else if ((flags & (1 | 16)) === (1 | 16)) {
        const subs = dep.subs!;
        if (update(dep)) {
          if (subs.nextSub !== undefined) shallowPropagate(subs);
          dirty = true;
        }
      } else if ((flags & (1 | 32)) === (1 | 32)) {
        stack = { value: link, prev: stack };
        link = dep.deps!;
        sub = dep;
        ++checkDepth;
        continue;
      }
      if (!dirty) {
        const nextDep = link.nextDep;
        if (nextDep !== undefined) {
          link = nextDep;
          continue;
        }
      }
      while (checkDepth--) {
        link = stack!.value;
        stack = stack!.prev;
        if (dirty) {
          const subs = sub.subs!;
          if (update(sub)) {
            if (subs.nextSub !== undefined) shallowPropagate(subs);
            sub = link.sub;
            continue;
          }
          dirty = false;
        } else {
          sub.flags &= ~32;
        }
        sub = link.sub;
        const nextDep = link.nextDep;
        if (nextDep !== undefined) {
          link = nextDep;
          continue top;
        }
      }
      return dirty && !!sub.flags;
    } while (true);
  }

  function shallowPropagate(link: Link): void {
    do {
      const sub = link.sub;
      const flags = sub.flags;
      if ((flags & (32 | 16)) === 32) {
        sub.flags = flags | 16;
        if ((flags & (2 | 4)) === 2) notify(sub);
      }
    } while ((link = link.nextSub!) !== undefined);
  }

  function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
    let link = sub.depsTail;
    while (link !== undefined) {
      if (link === checkLink) return true;
      link = link.prevDep;
    }
    return false;
  }
}
