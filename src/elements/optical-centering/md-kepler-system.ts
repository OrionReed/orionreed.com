import {
  circle,
  Diagram,
  drag,
  drive,
  ellipse,
  label,
  type Mount,
  num,
  cell,
  Vec,
  vec,
  type Writable,
} from "../../minim";

// md-kepler-system.ts — the solar-system demo upgraded to *real* orbits.
//
// Bodies ride genuine Kepler ellipses (sun at a focus) and obey Kepler's
// second law — fast at periapsis, slow at apoapsis — yet the whole system
// is still deterministic in one scalar, `time`, and every body is still
// draggable-to-scrub-time. The trick is that the only transcendental step
// runs on the READ path, and its inverse is closed form:
//
//   time ──affine──► M ──Kepler──► E ──ellipse──► pos
//          k·t+φ        Newton        a,b,ω,focus
//
//   • time → M (mean anomaly): an invertible affine — today's chain.
//   • M → E (eccentric anomaly): forward solves M = E − e·sin E by Newton;
//     the DRAG direction is the trivial closed form M = E − e·sin E. Since
//     dM/dE = 1 − e·cos E > 0 for e < 1 it's a strict bijection.
//   • E → pos on the ellipse `(a(cos E − e), b·sin E)` rotated by ω about
//     the focus; the inverse de-rotates the drag and reads off E.
//
// So dragging any body inverts pos → E → M → time, every other body
// re-derives, and the speed variation falls out of Kepler's equation for
// free. Layout is a small KSP-style system: inner rocky worlds, a
// homeworld + moon, a ringed gas giant with moonlets, and a steep-ellipse
// comet that crosses everything to show the speed-up at periapsis.

const TAU = Math.PI * 2;

/** Wrap an angle to (−π, π]. */
const wrapToPi = (x: number): number => x - TAU * Math.round(x / TAU);

/** Solve Kepler's equation M = E − e·sin E for the eccentric anomaly.
 *  Newton on the wrapped mean anomaly; revolutions are added back so the
 *  angle keeps accumulating and drags never jump a full turn. */
const solveKepler = (M: number, e: number): number => {
  const turns = Math.round(M / TAU);
  const m = M - turns * TAU;
  let E = m + e * Math.sin(m);
  for (let i = 0; i < 5; i++) {
    const d = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E + turns * TAU;
};

export class MdKeplerSystem extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(600, 460);

    const time = num(0);
    const dragging = cell(false);
    const star = vec(view.center.value.x, view.center.value.y);

    /** A body on a Keplerian ellipse about `parent` (the focus). */
    const kepler = (
      parent: Writable<Vec>,
      a: number,
      e: number,
      period: number,
      phase: number,
      omega: number,
      color: string,
      size: number,
    ): Writable<Vec> => {
      const b = a * Math.sqrt(1 - e * e);
      const cw = Math.cos(omega);
      const sw = Math.sin(omega);
      const focusOffset = a * e; // centre sits this far from the focus toward apoapsis

      // Mean anomaly: invertible affine of the shared clock.
      const M = time.affine(TAU / period, phase);
      // Eccentric anomaly: forward solves Kepler (Newton), inverse is the
      // closed form — so the chain stays invertible end to end.
      const E = M.lens(
        m => solveKepler(m, e),
        eVal => eVal - e * Math.sin(eVal),
      );

      // Position on the ellipse with the focus pinned at `parent`.
      const pos = Vec.lens(
        E,
        ev => {
          const px = a * (Math.cos(ev) - e);
          const py = b * Math.sin(ev);
          const f = parent.value;
          return { x: f.x + px * cw - py * sw, y: f.y + px * sw + py * cw };
        },
        (target, ev) => {
          const f = parent.peek();
          const dx = target.x - f.x;
          const dy = target.y - f.y;
          const ux = dx * cw + dy * sw; // de-rotate into the orbit frame
          const uy = -dx * sw + dy * cw;
          const aim = Math.atan2(uy / b, ux / a + e); // invert the ellipse param
          return ev + wrapToPi(aim - ev); // nearest representative — no full-turn jumps
        },
      );

      // Orbit path: ellipse centred between focus and apoapsis.
      const ringCenter = Vec.derive(() => {
        const f = parent.value;
        return { x: f.x - focusOffset * cw, y: f.y - focusOffset * sw };
      });
      s(ellipse(ringCenter, a, b, omega, { thin: true, dashed: true, opacity: 0.16 }));

      const body = s(circle(pos, size, { fill: color }));
      drag(body, pos, dragging);
      return pos;
    };

    // Star at the world origin (no drag target).
    s(circle(star, 13, { fill: true }));

    /* ember */ kepler(star, 50, 0.38, 5, 0.4, 0.4, "#f5a623", 5);

    const terra = kepler(star, 98, 0.04, 13, 0.0, 0.0, "#5b8def", 7.5);
    /* luna  */ kepler(terra, 18, 0.06, 2.4, 1.0, 0.0, "#cfd2d6", 3.5);

    const jove = kepler(star, 150, 0.05, 24, 1.0, 1.0, "#d8b27a", 12);
    /* moonlet */ kepler(jove, 18, 0.05, 2.4, 0.0, 0.0, "#bbbbbb", 3);
    /* moonlet */ kepler(jove, 32, 0.3, 5.2, 1.6, 1.6, "#c7b8a0", 3);

    /* comet */ kepler(star, 108, 0.62, 18, 2.4, 2.4, "#9fd8e8", 3.5);

    // Run time forward; pause while any body is dragged — the drag IS the
    // time-scrub, inverting pos → E → M → time.
    this.anim.start(
      drive(tick => {
        if (dragging.value) return;
        time.value = time.peek() + tick.dt;
      }),
    );

    s(
      label(view.top.down(20), "drag any body — real elliptical orbits, faster near the star"),
      label(
        view.bottom.up(16),
        "pos ← E ← Kepler(M = τ·time/period + φ) · drag inverts via M = E − e·sin E",
        { size: 10 },
      ),
    );
  }
}
