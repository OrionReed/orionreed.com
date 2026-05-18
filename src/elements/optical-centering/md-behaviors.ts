import {Diagram, Mount, Anchor, attract, signal, circle, driven, drive, easeInOut, label, loop, num, play, vec, spring, value, wave, type Val, Num, Vec} from "../../minim";

const N_TRAIL = 14;
const N_CHAIN = 10;
const LINK_LEN = 11;

/** Constant-velocity advance — `sig += v·dt`. */
const drift = (sig: Num, v: Val<number>) =>
  driven(sig, (dt, _t, cur) => cur + value(v) * dt);

const sine     = (t: number, f: number) => Math.sin(2 * Math.PI * f * t);
const triangle = (t: number, f: number) => 1 - 4 * Math.abs(((t * f) % 1) - 0.5);
const sawtooth = (t: number, f: number) => 2 * ((t * f) % 1) - 1;

/** `drift` with walls: flips velocity at bounds. */
function bounceFlip(x: Num, v: Num, lo: number, hi: number) {
  return drive(() => {
    if (x.value > hi && v.value > 0) v.value = -v.value;
    else if (x.value < lo && v.value < 0) v.value = -v.value;
  });
}

export class MdBehaviors extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 360);
    const wall = view.w.value - 40;
    const cx = view.w.value / 2;
    const laneY = (i: number) => view.h.value * ((i + 1) / 4);

    const trail = (
      seedX: Num,
      seedY: Num,
      color: string,
      attach: (sig: Num, target: Val<number>) => void,
    ) => {
      let prevX: Val<number> = seedX;
      let prevY: Val<number> = seedY;
      for (let i = 0; i < N_TRAIL; i++) {
        const x = num(seedX.peek());
        const y = num(seedY.peek());
        attach(x, prevX);
        attach(y, prevY);
        s(
          circle(vec(x, y), 7 - i * 0.3, {
            fill: color,
            opacity: 0.85 - i * 0.045,
          }),
        );
        prevX = x;
        prevY = y;
      }
    };

    const ax = num(cx);
    const ay = num(laneY(0));
    const av = num(180);
    this.anim.start(
      play([
        drift(ax, av),
        wave(ay, (t, y0) => y0 + 32 * sine(t, 0.4)),
        bounceFlip(ax, av, 40, wall),
      ]),
    );
    s(circle(vec(ax, ay), 9, { fill: "#1a1a1a" }));
    trail(ax, ay, "#5b8def", (sig, target) => {
      this.anim.start(attract(sig, target, 9));
    });

    // `byAmp` reactive: pause loop tweens it to 0 so both axes freeze together.
    const bx = num(cx);
    const by = num(laneY(1));
    const bv = num(-150);
    const byAmp = num(32);
    this.anim.start(
      play([
        drift(bx, bv),
        wave(by, (t, y0) => y0 + byAmp.peek() * triangle(t, 0.7)),
        bounceFlip(bx, bv, 40, wall),
      ]),
    );
    this.anim.start(
      loop(function* () {
        yield 1.5;
        yield* play([
          bv.to(0, 0.4, easeInOut),
          byAmp.to(0, 0.4, easeInOut),
        ]);
        yield 0.7;
        byAmp.value = 32;
        bv.value = bx.value < cx ? 155 : -155;
      }),
    );
    s(circle(vec(bx, by), 9, { fill: "#1a1a1a" }));
    trail(bx, by, "#e25c5c", (sig, target) => {
      this.anim.start(spring(sig, target, { omega: 14, zeta: 0.5 }));
    });

    const lc = { x: cx, y: laneY(2) };
    const phase = num(0);
    this.anim.start(drift(phase, 1));
    const headPos = vec(
      () => lc.x + 90 * Math.sin(phase.value * 1.6),
      () => lc.y + 26 * Math.sin(phase.value * 2.3 + 0.6),
    );
    s(circle(headPos, 9, { fill: "#1a1a1a" }));

    const links: Vec[] = Array.from({ length: N_CHAIN }, (_, i) =>
      vec(lc.x - i * LINK_LEN, lc.y),
    );
    this.anim.start(
      drive(() => {
        let prev = headPos.value;
        for (let i = 0; i < N_CHAIN; i++) {
          const cur = links[i].peek();
          const dx = cur.x - prev.x;
          const dy = cur.y - prev.y;
          const dist = Math.hypot(dx, dy) || 0.001;
          links[i].value = {
            x: prev.x + (dx / dist) * LINK_LEN,
            y: prev.y + (dy / dist) * LINK_LEN,
          };
          prev = links[i].value;
        }
      }),
    );
    for (let i = 0; i < N_CHAIN; i++) {
      s(
        circle(links[i], 6.5 - i * 0.45, {
          fill: "#1abc9c",
          opacity: 0.85 - i * 0.065,
        }),
      );
    }

    s(
      label(
        view.bottom.up(12),
        "attract (smooth) · spring (elastic, pauses) · play(rigid-link)",
        { size: 10, align: Anchor.Center, opacity: 0.55 },
      ),
    );
  }
}
