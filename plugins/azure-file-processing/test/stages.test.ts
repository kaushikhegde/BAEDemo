import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { listStages, resolveStage, resetStageCache } from "../src/workspace/tools/stages.js";
import { loadConfig } from "../src/shared/config.js";

const ctx = { cfg: loadConfig({}) };

const serveConfig = (workflows: unknown[]) =>
  vi.spyOn(globalThis, "fetch" as never).mockResolvedValue({
    ok: true, status: 200,
    text: async () => JSON.stringify({ workflows }),
  } as never);

beforeEach(() => resetStageCache());
afterEach(() => vi.restoreAllMocks());

describe("the stage catalogue comes from the server", () => {
  it("derives level from the parameters a workflow interpolates", async () => {
    serveConfig([
      { key: "capabilities", params: ["project"] },
      { key: "datamodel", params: ["project", "feature"] },
    ]);
    const stages = await listStages(ctx);
    expect(stages.find((s) => s.key === "capabilities")!.level).toBe("project");
    // Feature-level because it READS {feature}, not because a list here says so.
    expect(stages.find((s) => s.key === "datamodel")!.level).toBe("feature");
  });

  it("accepts a stage this package has never heard of", async () => {
    // The property that matters: `extract` was added to the pipeline after the
    // plugin shipped its hard-coded list, and was refused while the engine ran
    // it fine. Nothing in this package names it.
    serveConfig([{ key: "extract", params: ["project"] }]);
    await expect(resolveStage(ctx, "extract")).resolves.toMatchObject({
      key: "extract", level: "project",
    });
  });

  it("refuses an unknown key by naming what the SERVER offers", async () => {
    serveConfig([
      { key: "capabilities", params: ["project"] },
      { key: "revise-capabilities", params: ["project"], variantOf: "capabilities" },
    ]);
    // Generation keys first; variants named separately so they do not bury it.
    // "Available:" rather than "This server offers:" — the reader installed a
    // plugin and has no notion of which server answered.
    await expect(resolveStage(ctx, "nope")).rejects.toThrow(/Available: capabilities/);
    await expect(resolveStage(ctx, "nope")).rejects.toThrow(/revise-capabilities/);
  });

  it("refetches once on a miss, so a newly added stage does not need a restart", async () => {
    const fetchMock = serveConfig([{ key: "capabilities", params: ["project"] }]);
    await listStages(ctx);                       // warm the cache without `extract`

    // The server gains a stage while this process is running.
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        workflows: [{ key: "capabilities", params: ["project"] }, { key: "extract", params: ["project"] }],
      }),
    } as never);

    // Refusing from the warm cache here would be the same staleness this module
    // exists to prevent, just with a shorter half-life.
    await expect(resolveStage(ctx, "extract")).resolves.toMatchObject({ key: "extract" });
  });

  it("does not refetch when the key is already known", async () => {
    const fetchMock = serveConfig([{ key: "capabilities", params: ["project"] }]);
    await listStages(ctx);
    const before = fetchMock.mock.calls.length;
    await resolveStage(ctx, "capabilities");
    // A round trip in front of every ordinary call is what the cache prevents.
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("treats an empty workflow list as a broken server, not as 'nothing to run'", async () => {
    serveConfig([]);
    // The CODE is the contract, not the prose. An installation with nothing
    // compiled is an operator's problem — the caller gets a reference and the
    // cause goes to the log, so asserting on "reported no workflows" would be
    // asserting on text that deliberately no longer reaches a user.
    await expect(listStages(ctx)).rejects.toThrow(/^no_workflows:/);
    // And it must still not read as an empty, successful catalogue.
    await expect(listStages(ctx)).rejects.toThrow(/could not complete/);
  });
});
