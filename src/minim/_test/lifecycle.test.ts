// lifecycle.test.ts — disposal, dispose-fn idempotence, equals-skip,
// large-scale unwatch.

import { effect, signal, vec } from "@minim/signals";
import { describe, it } from "vitest";
import { check, section } from "./_check";

describe("lifecycle", () => {
  it("all checks", () => {
    section("effect-mirror: dispose severs the binding");
    {
      const src = signal(0);
      const t = signal(0);
      const stop = effect(() => {
        t.value = src.value;
      });
      check("src has subs from effect", src.subs !== undefined);
      stop();
      check("src.subs cleared after dispose", src.subs === undefined);
    }

    section("Effect after mirror disposed: no propagation");
    {
      const src = signal(0);
      const t = signal(0);
      const stop = effect(() => {
        t.value = src.value;
      });
      let observed = -1;
      const stopE = effect(() => {
        observed = t.value;
      });
      src.value = 10;
      check("effect observes through mirror", observed === 10);
      stop();
      src.value = 20;
      check("after dispose, no propagation", observed === 10);
      stopE();
    }

    section("Dispose fn is idempotent");
    {
      const src = signal(0);
      const t = signal(0);
      const stop = effect(() => {
        t.value = src.value;
      });
      stop();
      let threw = false;
      try {
        stop();
      } catch {
        threw = true;
      }
      check("safe to call stop twice", !threw);
    }

    section("equals trait: structural equality skips writes");
    {
      const v = vec(1, 2);
      let fires = 0;
      const stop = effect(() => {
        void v.value;
        fires++;
      });
      v.value = { x: 1, y: 2 };
      check("equals skips no-op write", fires === 1);
      v.value = { x: 1, y: 3 };
      check("real change fires", fires === 2);
      stop();
    }

    section("100 effect-mirrors on one source: clean unwatch leaves no subs");
    {
      const src = signal(0);
      const stops: Array<() => void> = [];
      for (let i = 0; i < 100; i++) {
        const t = signal(0);
        stops.push(
          effect(() => {
            t.value = src.value;
          }),
        );
      }
      let count = 0;
      for (let link = src.subs; link; link = link.nextSub) count++;
      check("src has 100 subs", count === 100);
      for (const s of stops) s();
      count = 0;
      for (let link = src.subs; link; link = link.nextSub) count++;
      check("after disposing all: 0 subs", count === 0);
    }
  });
});
