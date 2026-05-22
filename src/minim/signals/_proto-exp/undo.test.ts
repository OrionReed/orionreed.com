// _proto-exp/undo.test.ts — undo via recorded inverses.

import { describe, expect, it } from "vitest";
import { record, recordingSource, undo } from "./undo";

describe("undo: record + undo a sequence of writes", () => {
  it("undoes back to recorded start", () => {
    const x = recordingSource(0);
    const y = recordingSource(100);

    const history: Array<{ cell: unknown; prev: unknown; next: unknown }> = [];

    record(history, () => {
      x.value = 5;
      y.value = 200;
      x.value = 10;
    });

    expect(x.value).toBe(10);
    expect(y.value).toBe(200);
    expect(history.length).toBe(3);

    undo(history);

    expect(x.value).toBe(0);
    expect(y.value).toBe(100);
    expect(history.length).toBe(0);
  });

  it("only writes within record() are tracked", () => {
    const x = recordingSource(0);
    const history: Array<{ cell: unknown; prev: unknown; next: unknown }> = [];

    x.value = 1; // outside record — not tracked
    record(history, () => { x.value = 2 });
    x.value = 3; // outside record — not tracked

    expect(x.value).toBe(3);
    expect(history.length).toBe(1);
    expect(history[0].prev).toBe(1);
    expect(history[0].next).toBe(2);
  });
});
