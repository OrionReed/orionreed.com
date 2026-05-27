import {
  attract,
  circle,
  Diagram,
  drive,
  driven,
  label,
  type Mount,
  type Num,
  num,
  play,
  readNow,
  type Val,
  Vec,
  vec,
  type Writable,
  wave,
} from "../../minim";

const N_TRAIL = 14;
const N_CHAIN = 10;
const LINK_LEN = 11;

/** Constant-velocity advance — `sig += v·dt`. */
const drift = (sig: Writable<Num>, v: Val<number>) =>
  driven(sig, (dt, _t, cur) => cur + readNow(v) * dt);

const sine = (t: number, f: number) => Math.sin(2 * Math.PI * f * t);

/** `drift` with walls: flips velocity at bounds. */
function bounceFlip(x: Writable<Num>, v: Writable<Num>, lo: number, hi: number) {
  return drive(() => {
    if (x.value > hi && v.value > 0) v.value = -v.value;
    else if (x.value < lo && v.value < 0) v.value = -v.value;
  });
}

export class MdBehaviors extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 280);
    const wall = view.w.value - 40;
    const cx = view.w.value / 2;
    const laneY = (i: number) => view.h.value * ((i + 1) / 3);

    const trail = (
      seedX: Writable<Num>,
      seedY: Writable<Num>,
      color: string,
      attach: (sig: Writable<Num>, target: Val<number>) => void,
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

    const lc = { x: cx, y: laneY(1) };
    const phase = num(0);
    this.anim.start(drift(phase, 1));
    const headPos = Vec.derive(() => ({
      x: lc.x + 90 * Math.sin(phase.value * 1.6),
      y: lc.y + 26 * Math.sin(phase.value * 2.3 + 0.6),
    }));
    s(circle(headPos, 9, { fill: "#1a1a1a" }));

    const links: Writable<Vec>[] = Array.from({ length: N_CHAIN }, (_, i) =>
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

    s(label(view.bottom.up(12), "attract (smooth) · play(rigid-link)", { size: 10 }));
  }
}
