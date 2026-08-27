import { describe, it, expect, vi, afterEach } from "vitest";
import { makeLogger } from "../src/shared/logger.js";

const capture = () => {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write")
    .mockImplementation((s: any) => { lines.push(String(s)); return true; });
  return { lines, restore: () => spy.mockRestore() };
};

afterEach(() => vi.restoreAllMocks());

describe("makeLogger", () => {
  it("emits the event and its scalar fields", () => {
    const { lines, restore } = capture();
    makeLogger().info("job.queued", { jobId: "j1", sizeBytes: 42 });
    restore();
    const rec = JSON.parse(lines[0]);
    expect(rec.event).toBe("job.queued");
    expect(rec.jobId).toBe("j1");
    expect(rec.sizeBytes).toBe(42);
  });

  it("REFUSES a non-scalar field rather than serialising it", () => {
    // This is the whole guarantee: a caller cannot accidentally hand the logger
    // a buffer, a parsed document, or a request body and have it printed.
    const { restore } = capture();
    expect(() => makeLogger().info("upload", { body: { text: "secret" } as any }))
      .toThrow(/non-scalar/);
    restore();
  });

  it("refuses a string longer than the field cap", () => {
    const { restore } = capture();
    expect(() => makeLogger().info("x", { note: "a".repeat(600) }))
      .toThrow(/too long/);
    restore();
  });
});
