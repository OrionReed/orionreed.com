// `yield* rand(...gens)` — only the chosen branch runs, so unselected
// generators' side-effects (label updates, history pushes) never fire.
// Visualised by a current pick label, a candidates menu, and a rolling
// history strip.

import {
  Diagram,
  Scene,
  align,
  bounceIn,
  circle,
  computed,
  css,
  easeIn,
  easeInOut,
  easeOut,
  fadeOut,
  forEach,
  label,
  pt,
  rand,
  rect,
  signal,
  snapshot,
  type Animator,
  type Content,
  type Writable,
} from "../../minim";

const W = 600;
const H = 280;

const STAGE_X = 240;
const STAGE_Y = 120;

const HISTORY_LEN = 16;
const HISTORY_DOT_R = 7;
const HISTORY_GAP = 4;
const HISTORY_Y = H - 36;

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
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected scene(s: Scene): void {
    s.view(0, 0, W, H);

    // ── State ────────────────────────────────────────────────────────
    const current = signal<Pick | null>(null);
    const currentName = computed<Content>(() => current.value?.name ?? "—");
    const currentColor = computed(() => current.value?.color ?? "#1a1a1a");
    const history = signal<Pick[]>([]);

    // ── Header ───────────────────────────────────────────────────────
    s(
      label(pt(20, 24), "rand", {
        size: 13,
        bold: true,
        align: align.left,
        opacity: 0.85,
      }),
      label(
        pt(20, 42),
        "yield* rand(...gens) — pick one branch each loop",
        { size: 10, align: align.left, opacity: 0.5 },
      ),
    );

    // ── Stage ────────────────────────────────────────────────────────
    s(
      label(pt(STAGE_X, STAGE_Y - 60), currentName, {
        size: 18,
        bold: true,
        align: align.center,
      }),
    );
    const subject = s(
      circle(pt(STAGE_X, STAGE_Y), 22, { fill: currentColor }),
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
      label(pt(MENU_X, MENU_Y - 22), "candidates", {
        size: 10,
        align: align.left,
        opacity: 0.5,
      }),
    );
    MOVES.forEach((m, i) => {
      const isActive = computed(() => current.value?.name === m.name);
      const opacity = computed(() => (isActive.value ? 1 : 0.4));
      s(
        circle(pt(MENU_X, MENU_Y + i * ROW_H), 5, {
          fill: m.color,
          opacity,
        }),
        label(pt(MENU_X + 14, MENU_Y + i * ROW_H), m.name, {
          size: 12,
          align: align.left,
          opacity,
        }),
      );
    });

    // ── History strip (rolling, oldest left) ─────────────────────────
    const HISTORY_STRIDE = HISTORY_DOT_R * 2 + HISTORY_GAP;
    const HISTORY_X0 = W / 2 - ((HISTORY_LEN - 1) * HISTORY_STRIDE) / 2;

    s(
      label(pt(W / 2, HISTORY_Y - 22), "history (newest →)", {
        size: 10,
        align: align.center,
        opacity: 0.5,
      }),
    );

    forEach(
      s.root,
      // Pad-left to a fixed width; chips slide right as the strip
      // fills, empty slots render as faint outlines.
      computed(() => {
        const h = history.value;
        const pad = HISTORY_LEN - h.length;
        const slots: (Pick | null)[] = [];
        for (let i = 0; i < pad; i++) slots.push(null);
        for (const p of h) slots.push(p);
        return slots;
      }),
      (item, i) => {
        if (!item) {
          return rect(
            pt(
              HISTORY_X0 + i * HISTORY_STRIDE - HISTORY_DOT_R,
              HISTORY_Y - HISTORY_DOT_R,
            ),
            HISTORY_DOT_R * 2,
            HISTORY_DOT_R * 2,
            { stroke: "#1a1a1a", opacity: 0.1, corner: 2 },
          );
        }
        // Older entries fade so the eye tracks the recent tail.
        const age = HISTORY_LEN - 1 - i;
        const opacity = Math.max(0.25, 1 - age * 0.06);
        return circle(
          pt(HISTORY_X0 + i * HISTORY_STRIDE, HISTORY_Y),
          HISTORY_DOT_R,
          { fill: item.color, opacity },
        );
      },
      // Slot-index keys — slots don't change identity, only their
      // underlying item does.
      { key: (_, i) => i },
    );

    // ── Loop ────────────────────────────────────────────────────────
    // `record` sets the current pick + appends to history, then runs
    // the move body. Only the selected wrapper's side-effects fire.
    function* record(move: Move, body: Animator): Animator {
      const pick: Pick = { name: move.name, color: move.color };
      current.value = pick;
      const next = [...history.peek(), pick];
      if (next.length > HISTORY_LEN) next.shift();
      history.value = next;
      yield* body;
    }

    const anim = this.anim;
    anim.loop(function* () {
      reset();
      yield* rand(...MOVES.map((m) => record(m, m.run(subject))));
      yield 0.35;
    });
  }
}
