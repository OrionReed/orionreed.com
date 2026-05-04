import { BaseElement, attr, css } from "./base-element";
import { grey, ink, stroke } from "./color";
import * as R from "./rand";
import type { MdCellCircle } from "./md-cell-circle";

// Mutually exclusive state per cell. Absent (no entry) = not received.
type CellState = "received" | "retransmit" | "acknowledged";

interface Colors {
  broadcast: string;
  received: string;
  retransmit: string;
  floodFill: string;
  acknowledged: string;
}

const RECEIVE_CHANCE = 0.5;

const T = {
  broadcastStep: 80,
  beforeFlood: 800,
  floodCellStep: 25,
  afterFlood: 1000,
  betweenCycles: 2000,
  beforeReset: 1000,
  betweenFullCycles: 3000,
};

export class MdQrtpProtocol extends BaseElement {
  @attr({ type: "number" }) cells?: number;
  @attr({ type: "boolean" }) backchannel?: boolean;

  private floodAnim = this.anim.scope();
  private cellState = new Map<number, CellState>();
  private broadcastIndex = 0;
  private lastBroadcast = -1;
  private circleEl!: MdCellCircle;

  static styles = css`
    :host {
      display: block;
    }
  `;

  get cellCount(): number {
    return this.cells ?? 60;
  }

  private getColors(): Colors {
    return {
      broadcast: `${stroke}`,
      received: `${ink("green").mod(0.7)}`,
      retransmit: `${ink("orange").mod(0.7)}`,
      floodFill: `${ink("blue").mod(0.7)}`,
      acknowledged: `${grey.mod(0.7)}`,
    };
  }

  private reset(): void {
    this.cellState.clear();
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

  private restoreCell(i: number): void {
    const state = this.cellState.get(i);
    if (state === undefined) {
      this.circleEl.clearCell(i);
      return;
    }
    this.circleEl.setCell(i, this.getColors()[state]);
  }

  // Skip the currently-broadcasting cell so it stays the broadcast color.
  private paintCell(i: number, color?: string): void {
    if (i === this.lastBroadcast) return;
    if (color === undefined) this.restoreCell(i);
    else this.circleEl.setCell(i, color);
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
    const c = this.getColors();

    for (const component of components) {
      for (const cell of component) {
        this.paintCell(cell, c.floodFill);
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

    for (const component of components) {
      for (const cell of component) this.paintCell(cell);
    }
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

  protected render(): void {
    const label = this.textContent?.trim() ?? "";
    this.shadow.innerHTML = `
      <md-cell-circle cells="${this.cellCount}" width="0.2">${label}</md-cell-circle>
    `;
    this.circleEl = this.shadow.querySelector("md-cell-circle") as MdCellCircle;
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

      if (this.lastBroadcast !== -1) this.restoreCell(this.lastBroadcast);

      this.circleEl.setCell(this.broadcastIndex, this.getColors().broadcast);
      this.lastBroadcast = this.broadcastIndex;
      this.handleReception(this.broadcastIndex);
      this.broadcastIndex = (this.broadcastIndex + 1) % this.cellCount;

      if (this.cellState.size === this.cellCount) {
        await this.anim.wait(T.beforeReset);
        this.floodAnim.stop();
        this.reset();
        this.circleEl.clearAll();
        await this.anim.wait(T.betweenFullCycles);
        if (this.backchannel) this.startFloodFillLoop();
        return;
      }

      await this.anim.wait(T.broadcastStep);
    });
  }
}
