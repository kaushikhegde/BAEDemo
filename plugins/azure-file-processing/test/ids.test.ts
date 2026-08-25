import { describe, it, expect } from "vitest";
import { newJobId } from "../src/shared/ids.js";

describe("newJobId", () => {
  it("is safe as an Azure Table RowKey and a blob path segment", () => {
    const id = newJobId();
    expect(id).toMatch(/^j-[0-9a-z]{9}-[0-9a-f]{12}$/);
    expect(id).not.toMatch(/[/\\#?]/); // characters Table Storage rejects in a RowKey
  });

  it("sorts lexicographically in creation order", () => {
    const a = newJobId(1_700_000_000_000, Buffer.alloc(6, 0xff));
    const b = newJobId(1_700_000_001_000, Buffer.alloc(6, 0x00));
    expect([b, a].sort()).toEqual([a, b]);
  });

  it("is unique for two calls in the same millisecond", () => {
    const t = 1_700_000_000_000;
    expect(newJobId(t)).not.toBe(newJobId(t));
  });
});
