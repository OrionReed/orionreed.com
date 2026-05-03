import { BaseElement, attr, css } from "./base-element";
import { Anim } from "./anim";
import type { MdCellCircle } from "./md-cell-circle";

interface Colors {
  broadcast: string;
  received: string;
  retransmit: string;
  floodFill: string;
  acknowledged: string;
}

export class MdQrtpProtocol extends BaseElement {
  @attr({ type: "number" }) cells?: number;
  @attr({ type: "boolean" }) backchannel?: boolean;

  private floodAnim = new Anim();

  private received = new Set<number>();
  private retransmit = new Set<number>();
  private acknowledged = new Set<number>();
  private broadcastIndex = 0;
  private lastBroadcast = -1;

  static styles = css`
    :host {
      display: block;
    }
  `;

  get cellCount(): number {
    return this.cells ?? 60;
  }

  private get circle(): MdCellCircle {
    return this.shadow.querySelector("md-cell-circle") as MdCellCircle;
  }

  private getColors(): Colors {
    const root = getComputedStyle(document.documentElement);
    return {
      broadcast: root.getPropertyValue("--color-black").trim(),
      received: root.getPropertyValue("--color-green").trim(),
      retransmit: root.getPropertyValue("--color-orange").trim(),
      floodFill: root.getPropertyValue("--color-blue").trim(),
      acknowledged: root.getPropertyValue("--color-gray").trim(),
    };
  }

  private reset(): void {
    this.received.clear();
    this.retransmit.clear();
    this.acknowledged.clear();
    this.broadcastIndex = 0;
    this.lastBroadcast = -1;
  }

  private restoreCell(i: number): void {
    const c = this.getColors();
    if (this.acknowledged.has(i)) this.circle.setCell(i, c.acknowledged);
    else if (this.retransmit.has(i)) this.circle.setCell(i, c.retransmit);
    else if (this.received.has(i)) this.circle.setCell(i, c.received);
    else this.circle.clearCell(i);
  }

  private handleReception(i: number): void {
    if (this.received.has(i)) {
      if (Math.random() < 0.35) this.retransmit.add(i);
    } else {
      if (Math.random() < 0.35) this.received.add(i);
    }
  }

  private buildComponents(): number[][] {
    const visited = new Set<number>();
    const components: number[][] = [];
    const n = this.cellCount;

    for (const seed of this.retransmit) {
      if (visited.has(seed)) continue;
      const component: number[] = [];
      const queue = [seed];
      while (queue.length > 0) {
        const cell = queue.shift()!;
        if (visited.has(cell)) continue;
        visited.add(cell);
        component.push(cell);
        for (const neighbor of [(cell - 1 + n) % n, (cell + 1) % n]) {
          if (!visited.has(neighbor) && this.received.has(neighbor)) {
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

    // Animate flood fill expansion cell by cell
    for (const component of components) {
      for (const cell of component) {
        if (cell !== this.lastBroadcast) this.circle.setCell(cell, c.floodFill);
        await this.floodAnim.wait(25);
      }
    }

    await this.floodAnim.wait(1000);

    // Restore blue cells back to their state
    for (const component of components) {
      for (const cell of component) {
        if (cell !== this.lastBroadcast) this.restoreCell(cell);
      }
    }

    // Reset all retransmit cells to received (green)
    const c2 = this.getColors();
    for (const cell of this.retransmit) {
      if (cell !== this.lastBroadcast) this.circle.setCell(cell, c2.received);
    }
    this.retransmit.clear();

    // If skip mode: mark flood-fill range as acknowledged (gray)
    if (this.backchannel) {
      for (const component of components) {
        for (const cell of component) {
          this.acknowledged.add(cell);
          if (cell !== this.lastBroadcast) {
            this.circle.setCell(cell, c2.acknowledged);
          }
        }
      }
    }
  }

  private startFloodFillLoop(): void {
    this.floodAnim = new Anim();
    this.floodAnim.loop(async () => {
      await this.floodAnim.wait(() => this.retransmit.size > 0);
      await this.floodAnim.wait(800);
      await this.doFloodFill();
      await this.floodAnim.wait(2000);
    });
  }

  protected render(): void {
    const label = this.textContent?.trim() ?? "";
    this.shadow.innerHTML = `
      <md-cell-circle cells="${this.cellCount}" width="0.2">${label}</md-cell-circle>
    `;
  }

  connectedCallback(): void {
    super.connectedCallback(); // creates fresh this.anim, calls render()

    this.reset();
    if (this.backchannel) this.startFloodFillLoop();

    this.anim.loop(async () => {
      // Skip acknowledged cells without delay
      if (this.backchannel && this.acknowledged.has(this.broadcastIndex)) {
        this.broadcastIndex = (this.broadcastIndex + 1) % this.cellCount;
        return;
      }

      if (this.lastBroadcast !== -1) this.restoreCell(this.lastBroadcast);

      const c = this.getColors();
      this.circle.setCell(this.broadcastIndex, c.broadcast);
      this.lastBroadcast = this.broadcastIndex;
      this.handleReception(this.broadcastIndex);
      this.broadcastIndex = (this.broadcastIndex + 1) % this.cellCount;

      if (this.received.size === this.cellCount) {
        await this.anim.wait(1000);
        this.floodAnim.stop();
        this.reset();
        this.circle.clearAll();
        await this.anim.wait(3000);
        if (this.backchannel) this.startFloodFillLoop();
        return;
      }

      await this.anim.wait(80);
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.floodAnim.stop();
  }
}
