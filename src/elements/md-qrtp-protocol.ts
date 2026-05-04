import { attr, css } from "./base-element";
import { grey, ink, stroke } from "./color";
import type { Fill, Padding, Scene } from "./draw";
import { polar, pt } from "./geom";
import * as R from "./rand";
import { SceneElement } from "./scene-element";

type CellState = "received" | "retransmit" | "acknowledged";

const RECEIVE_CHANCE = 0.5;
const RING_OUTER = 150;
const RING_WIDTH_RATIO = 0.2;
const TAU = Math.PI * 2;

const T = {
  broadcastStep: 80,
  beforeFlood: 800,
  floodCellStep: 25,
  afterFlood: 1000,
  betweenCycles: 2000,
  beforeReset: 1000,
  betweenFullCycles: 3000,
};

export class MdQrtpProtocol extends SceneElement {
  @attr({ type: "number" }) cells?: number;
  @attr({ type: "boolean" }) backchannel?: boolean;

  private floodAnim = this.anim.scope();
  private cellState = new Map<number, CellState>();
  // Transient overlay (e.g. flood-fill blue) that wins over state-based fills.
  private cellOverrides = new Map<number, Fill>();
  private broadcastIndex = 0;
  private lastBroadcast = -1;

  static styles = css`
    :host {
      --scene-max-width: 320px;
    }
  `;

  get cellCount(): number {
    return this.cells ?? 60;
  }

  protected scenePadding(): Padding {
    return 8;
  }

  private cellFill(i: number): Fill | undefined {
    const override = this.cellOverrides.get(i);
    if (override !== undefined) return override;
    if (i === this.lastBroadcast) return `${stroke}`;
    const state = this.cellState.get(i);
    if (state === "received") return `${ink("green").mod(0.7)}`;
    if (state === "retransmit") return `${ink("orange").mod(0.7)}`;
    if (state === "acknowledged") return `${grey.mod(0.7)}`;
    return undefined;
  }

  private reset(): void {
    this.cellState.clear();
    this.cellOverrides.clear();
    this.broadcastIndex = 0;
    this.lastBroadcast = -1;
  }

  private cellsWithState(state: CellState): number[] {
    const result: number[] = [];
    for (const [i, s] of this.cellState) {
      if (s === state) result.push(i);
    }
    return result;
  }

  private handleReception(i: number): void {
    const state = this.cellState.get(i);
    if (state === "received") {
      if (R.chance(RECEIVE_CHANCE)) this.cellState.set(i, "retransmit");
    } else if (state === undefined) {
      if (R.chance(RECEIVE_CHANCE)) this.cellState.set(i, "received");
    }
  }

  private buildComponents(): number[][] {
    const visited = new Set<number>();
    const components: number[][] = [];
    const n = this.cellCount;
    for (const seed of this.cellsWithState("retransmit")) {
      if (visited.has(seed)) continue;
      const component: number[] = [];
      const queue = [seed];
      while (queue.length > 0) {
        const cell = queue.shift()!;
        if (visited.has(cell)) continue;
        visited.add(cell);
        component.push(cell);
        for (const neighbor of [(cell - 1 + n) % n, (cell + 1) % n]) {
          // Flood crosses any received-once neighbor (incl. acknowledged).
          if (!visited.has(neighbor) && this.cellState.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }
      if (component.length > 0) components.push(component);
    }
    return components;
  }

  private async doFloodFill(): Promise<void> {
    const components = this.buildComponents();
    const flood = `${ink("blue").mod(0.7)}`;

    for (const component of components) {
      for (const cell of component) {
        if (cell !== this.lastBroadcast) {
          this.cellOverrides.set(cell, flood);
          this.render();
        }
        await this.floodAnim.wait(T.floodCellStep);
      }
    }

    await this.floodAnim.wait(T.afterFlood);

    for (const cell of this.cellsWithState("retransmit")) {
      this.cellState.set(cell, "received");
    }

    if (this.backchannel) {
      for (const component of components) {
        for (const cell of component) {
          this.cellState.set(cell, "acknowledged");
        }
      }
    }

    this.cellOverrides.clear();
    this.render();
  }

  private startFloodFillLoop(): void {
    this.floodAnim = this.anim.scope();
    this.floodAnim.loop(async () => {
      await this.floodAnim.until(
        () => this.cellsWithState("retransmit").length > 0,
      );
      await this.floodAnim.wait(T.beforeFlood);
      await this.doFloodFill();
      await this.floodAnim.wait(T.betweenCycles);
    });
  }

  protected draw(s: Scene): void {
    const cx = RING_OUTER;
    const cy = RING_OUTER;
    const rOut = RING_OUTER;
    const rIn = rOut * (1 - RING_WIDTH_RATIO);
    const N = this.cellCount;
    const start = -Math.PI / 2;

    // Fills first so the outline strokes paint over their edges.
    for (let i = 0; i < N; i++) {
      const fill = this.cellFill(i);
      if (!fill) continue;
      const a0 = start + (i * TAU) / N;
      const a1 = a0 + TAU / N;
      s.annularSector(cx, cy, rOut, rIn, a0, a1, { fill });
    }

    s.circle(cx, cy, rOut, { thin: true });
    s.circle(cx, cy, rIn, { thin: true });

    for (let i = 0; i < N; i++) {
      const a = start + (i * TAU) / N;
      s.line(polar(cx, cy, rIn, a), polar(cx, cy, rOut, a), { thin: true });
    }

    const label = this.textContent?.trim() ?? "";
    if (label) s.label(pt(cx, cy), label, { bold: true });
  }

  connectedCallback(): void {
    super.connectedCallback();

    this.reset();
    if (this.backchannel) this.startFloodFillLoop();

    this.anim.loop(async () => {
      if (
        this.backchannel &&
        this.cellState.get(this.broadcastIndex) === "acknowledged"
      ) {
        this.broadcastIndex = (this.broadcastIndex + 1) % this.cellCount;
        return;
      }

      this.lastBroadcast = this.broadcastIndex;
      this.handleReception(this.broadcastIndex);
      this.broadcastIndex = (this.broadcastIndex + 1) % this.cellCount;
      this.render();

      if (this.cellState.size === this.cellCount) {
        await this.anim.wait(T.beforeReset);
        this.floodAnim.stop();
        this.reset();
        this.render();
        await this.anim.wait(T.betweenFullCycles);
        if (this.backchannel) this.startFloodFillLoop();
        return;
      }

      await this.anim.wait(T.broadcastStep);
    });
  }
}
