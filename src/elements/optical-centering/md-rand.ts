// `yield* rand(...gens)` — only the chosen branch runs, so unselected
// generators' side-effects (label updates, history pushes) never fire.
// Visualised by a current pick label, a candidates menu, and a rolling
// history strip.

import { Diagram, Mount, Anchor, bounceIn, cell, circle, easeIn, easeInOut, easeOut, fadeOut, label, loop, vec, rand, snapshot, type Animator, type Content, type Writable } from "../../minim";

const STAGE_X = 240;
const STAGE_Y = 120;


interface Pick {
  name: string;
  color: string;
}

type Subject = Writable<"translate" | "rotate" | "scale" | "opacity">;

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
      yield* bounceIn(s, 0.55);
    },
  },
  {
    name: "slide",
    color: "#7ed321",
    run: function* (s) {
      yield* s.translate.x
        .to(80, 0.35, easeInOut)
        .to(-80, 0.55, easeInOut)
        .to(0, 0.35, easeInOut);
    },
  },
  {
    name: "fade",
    color: "#9b59b6",
    run: function* (s) {
      yield* fadeOut(s, 0.3);
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
    const view = this.view(600, 280);

    // ── State ────────────────────────────────────────────────────────
    const current = cell<Pick | null>(null);
    const currentName = cell.derived<Content>(() => current.value?.name ?? "—");
    const currentColor = cell.derived(() => current.value?.color ?? "#1a1a1a");

    // ── Header ───────────────────────────────────────────────────────
    s(
      label(vec(20, 24), "rand", {
        size: 13,
        bold: true,
        align: Anchor.Left,
        opacity: 0.85,
      }),
      label(
        vec(20, 42),
        "yield* rand(...gens) — pick one branch each loop",
        { size: 10, align: Anchor.Left, opacity: 0.5 },
      ),
    );

    // ── Stage ────────────────────────────────────────────────────────
    const subject = s(
      circle(vec(STAGE_X, STAGE_Y), 22, { fill: currentColor }),
    );
    s(
      label(subject.center.up(60), currentName, {
        size: 18,
        bold: true,
        align: Anchor.Center,
      }),
    );
    // Each iteration starts from a clean pose — moves are free to
    // mutate translate/rotate/scale/opacity.
    const reset = snapshot(
      subject.translate,
      subject.rotate,
      subject.scale,
      subject.opacity,
    );

    // ── Candidates menu ──────────────────────────────────────────────
    const MENU_X = 440;
    const MENU_Y = 70;
    const ROW_H = 22;
    s(
      label(vec(MENU_X, MENU_Y - 22), "candidates", {
        size: 10,
        align: Anchor.Left,
        opacity: 0.5,
      }),
    );
    MOVES.forEach((m, i) => {
      const isActive = cell.derived(() => current.value?.name === m.name);
      const opacity = cell.derived(() => (isActive.value ? 1 : 0.4));
      s(
        circle(vec(MENU_X, MENU_Y + i * ROW_H), 5, {
          fill: m.color,
          opacity,
        }),
        label(vec(MENU_X + 14, MENU_Y + i * ROW_H), m.name, {
          size: 12,
          align: Anchor.Left,
          opacity,
        }),
      );
    });

    // ── Loop ────────────────────────────────────────────────────────
    // `record` sets the current pick + appends to history, then runs
    // the move body. Only the selected wrapper's side-effects fire.
    function* record(move: Move, body: Animator): Animator {
      current.value = { name: move.name, color: move.color };
      yield* body;
    }

    this.anim.start(loop(function* () {
      reset();
      yield* rand(...MOVES.map((m) => record(m, m.run(subject))));
      yield 0.35;
    }));
  }
}
