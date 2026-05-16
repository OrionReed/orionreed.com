// Common type contract for Anim prototype variants.
//
// Each variant exports a class that matches `IAnim` plus the helper
// functions `suspend` and `drive` rebound against its own primitives.
// The shared suite (./suite.ts) drives all variants through the same
// gauntlet of tests so we can compare apples to apples.

export interface IAnim {
  clock: number;
  observer: any;
  run(g: any): () => void;
  stop(): void;
  step(dt: number): void;
  onFrame(cb: (dt: number, t: number) => void): () => void;
}

export interface AnimModule {
  Anim: new () => IAnim;
  suspend: <T>(impl: any) => any;
  drive: (step: (dt: number, t: number) => boolean | void) => any;
  name: string;
}
