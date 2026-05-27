import {
  Anchor,
  type Animator,
  bounceIn,
  type Content,
  circle,
  Diagram,
  derive,
  easeIn,
  easeInOut,
  easeOut,
  fadeOut,
  type Has,
  label,
  loop,
  Mount,
  rand,
  signal,
  snapshot,
  vec,
} from "../../minim";

const STAGE_X = 240;
const STAGE_Y = 120;

interface Pick {
  name: string;
  color: string;
}

type Subject = Has<"translate" | "rotate" | "scale" | "opacity">;

interface Move {
  name: string;
  color: string;
  run: (s: Subject) => Animator;
}

const MOVES: Move[] = [
  {
    name: "spin",
    color: "#5b8def",
    run: function* (s) {
      yield* s.rotate.to(Math.PI * 2, 0.7, easeInOut);
      s.rotate.value = 0;
    },
  },
  {
    name: "hop",
    color: "#f5a623",
    run: function* (s) {
      yield* s.translate.y.to(-40, 0.25, easeOut).to(0, 0.35, easeInOut);
    },
  },
  {
    name: "pulse",
    color: "#e25c5c",
    run: function* (s) {
      yield bounceIn(s, 0.55);
    },
  },
  {
    name: "slide",
    color: "#7ed321",
    run: function* (s) {
      yield* s.translate.x.to(80, 0.35, easeInOut).to(-80, 0.55, easeInOut).to(0, 0.35, easeInOut);
    },
  },
  {
    name: "fade",
    color: "#9b59b6",
    run: function* (s) {
      yield fadeOut(s, 0.3);
      yield* s.opacity.to(1, 0.4, easeOut);
    },
  },
  {
    name: "drop",
    color: "#1abc9c",
    run: function* (s) {
      yield* s.translate.y.to(50, 0.35, easeIn);
      yield 0.1;
      yield* s.translate.y.to(0, 0.4, easeOut);
    },
  },
];

export class MdRand extends Diagram {
  protected scene(s: Mount): void {
    this.view(600, 280);

    const current = signal<Pick | null>(null);
    const currentName = derive<Content>(() => current.value?.name ?? "—");
    const currentColor = derive(() => current.value?.color ?? "#1a1a1a");

    s(
      label(vec(20, 24), "rand", { bold: true, align: Anchor.Left }),
      label(vec(20, 42), "yield* rand(...gens) — pick one branch each loop", {
        size: 10,
        align: Anchor.Left,
      }),
    );

    const subject = s(circle(vec(STAGE_X, STAGE_Y), 22, { fill: currentColor }));
    s(label(subject.center.up(60), currentName, { size: 18, bold: true }));
    const reset = snapshot(subject.translate, subject.rotate, subject.scale, subject.opacity);

    const MENU_X = 440;
    const MENU_Y = 70;
    const ROW_H = 22;
    s(label(vec(MENU_X, MENU_Y - 22), "candidates", { size: 10, align: Anchor.Left }));
    MOVES.forEach((m, i) => {
      const isActive = derive(() => current.value?.name === m.name);
      const opacity = derive(() => (isActive.value ? 1 : 0.4));
      s(
        circle(vec(MENU_X, MENU_Y + i * ROW_H), 5, {
          fill: m.color,
          opacity,
        }),
        // `opacity` reactive — pulses to highlight the active candidate.
        label(vec(MENU_X + 14, MENU_Y + i * ROW_H), m.name, {
          align: Anchor.Left,
          opacity,
        }),
      );
    });

    function* record(move: Move, body: Animator): Animator {
      current.value = { name: move.name, color: move.color };
      yield* body;
    }

    this.anim.start(
      loop(function* () {
        reset();
        yield* rand(...MOVES.map(m => record(m, m.run(subject))));
        yield 0.35;
      }),
    );
  }
}
