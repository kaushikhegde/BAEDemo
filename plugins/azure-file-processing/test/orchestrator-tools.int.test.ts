import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { listIssues } from "../src/workspace/tools/list-issues.js";
import { approveGate, rejectGate } from "../src/workspace/tools/gates.js";
import { pauseIssue, resumeIssue } from "../src/workspace/tools/control.js";
import { spend } from "../src/workspace/tools/spend.js";

const ctx = { cfg: loadConfig() };

beforeAll(async () => {
  const res = await fetch(`${ctx.cfg.orchUrl}/health`).catch(() => null);
  if (!res?.ok) throw new Error("The Scyne orchestrator is not running. `npm run dev` from the repo root.");
});

describe("listIssues", () => {
  it("returns a shaped list", async () => {
    const r = await listIssues(ctx, {});
    expect(Array.isArray(r.issues)).toBe(true);
    for (const i of r.issues.slice(0, 3)) {
      expect(i).toHaveProperty("issueId");
      expect(i).toHaveProperty("status");
      expect(i).toHaveProperty("needsHuman");
    }
  });

  it("filters by project without throwing on an unknown one", async () => {
    const r = await listIssues(ctx, { project: "NO-SUCH-PROJECT-XYZ" });
    expect(r.issues).toEqual([]);
  });
});

describe("gates", () => {
  it("refuses an unknown gate rather than reporting success", async () => {
    await expect(approveGate(ctx, { gateId: "00000000-0000-0000-0000-000000000000" }))
      .rejects.toThrow();
  });

  it("requires a note when rejecting", async () => {
    await expect(rejectGate(ctx, { gateId: "x", note: "" })).rejects.toThrow(/note/);
  });
});

describe("control", () => {
  it("refuses an unknown issue", async () => {
    await expect(pauseIssue(ctx, { issueId: "SCY-999999" })).rejects.toThrow();
  });
});

describe("spend", () => {
  it("groups by a legal dimension or refuses clearly", async () => {
    try {
      const r = await spend(ctx, { by: "project" });
      expect(r).toHaveProperty("by", "project");
    } catch (e: any) {
      // Admin-only upstream: a 403 must surface as a 403, not an empty table.
      expect(String(e.message)).toMatch(/403|forbidden|not allowed/i);
    }
  });

  it("refuses an unknown grouping", async () => {
    await expect(spend(ctx, { by: "banana" as any })).rejects.toThrow(/by/);
  });
});
