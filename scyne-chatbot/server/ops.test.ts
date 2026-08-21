// The ops reads — issues, spend, actions.
//
// The first tests in this package. What is worth covering here is not "does
// fetch work" but the two things that would be wrong silently: the step
// arithmetic, and whether a refusal survives the trip. An empty table is a
// confident answer, and rendering one to somebody who is simply not allowed to
// see the data is the failure this file exists to prevent.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { shapeIssue, listIssues, spend, actions, type WorkflowSteps } from "./store.js";

const STEPS: WorkflowSteps = {
  requirements: { count: 6, types: ["exec", "agent", "exec", "attach", "gate", "agent"] },
};

const issue = (over: Record<string, unknown> = {}) => ({
  id: "i1", identifier: "SCY-3", title: "Generate requirements — SAPN / interim-benefit",
  status: "in_review", workflow_key: "requirements", step_index: 4,
  params: { project: "SAPN", feature: "interim-benefit" },
  control_request: null, created_by: "me@scyne.test",
  created_at: "2026-08-21T00:00:00.000Z", updated_at: "2026-08-21T02:00:00.000Z",
  ...over,
});

describe("shapeIssue", () => {
  it("renders the step 1-based, with what that step does", () => {
    // step_index 4 is the FIFTH step, and it is the gate. Reporting "4" would
    // be the engine's index leaking into a sentence meant for a person.
    expect(shapeIssue(issue(), STEPS).step).toBe("5/6 gate");
  });

  it("does not run off the end of the step list when an issue is done", () => {
    // The engine moves step_index PAST the last step to finish, so a done
    // issue indexes one beyond its own list. Unclamped this read "7/6".
    const done = shapeIssue(issue({ status: "done", step_index: 6 }), STEPS);
    expect(done.step).toBe("6/6");
    expect(done.needsHuman).toBe(false);
  });

  it("falls back to the bare index for a workflow it has no step list for", () => {
    expect(shapeIssue(issue({ workflow_key: "unknown-stage" }), {}).step).toBe("4");
    expect(shapeIssue(issue({ workflow_key: "unknown-stage" }), {}).stepCount).toBeNull();
  });

  it.each([["in_review"], ["blocked"], ["paused"]])(
    "flags %s as needing a human", (status) => {
      expect(shapeIssue(issue({ status }), STEPS).needsHuman).toBe(true);
    });

  it.each([["todo"], ["in_progress"], ["done"], ["cancelled"]])(
    "does not flag %s", (status) => {
      expect(shapeIssue(issue({ status }), STEPS).needsHuman).toBe(false);
    });

  it("surfaces a control request, which is a REQUEST and not a status", () => {
    // An issue reading `in_progress` half an hour after somebody pressed Cancel
    // is the most confusing state this system has. The row has to name it.
    const r = shapeIssue(issue({ status: "in_progress", control_request: "cancel" }), STEPS);
    expect(r.status).toBe("in_progress");
    expect(r.controlRequest).toBe("cancel");
  });

  it("lifts project and feature out of params", () => {
    const r = shapeIssue(issue(), STEPS);
    expect(r.project).toBe("SAPN");
    expect(r.feature).toBe("interim-benefit");
  });

  it("survives a row with nothing on it rather than throwing", () => {
    // A project-level issue carries no feature; an old row may carry no params
    // at all. A list that throws on one row shows nothing for all of them.
    const r = shapeIssue({}, {});
    expect(r.feature).toBeNull();
    expect(r.identifier).toBe("");
  });
});

describe("listIssues", () => {
  const calls: Array<{ url: string; auth: string | undefined }> = [];

  const stub = (routes: Record<string, { status: number; body?: unknown }>) => {
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      calls.push({ url: u, auth: init?.headers?.authorization });
      const hit = Object.entries(routes).find(([p]) => u.includes(p))?.[1];
      if (!hit) return { ok: false, status: 404, json: async () => ({}) } as any;
      return {
        ok: hit.status >= 200 && hit.status < 300,
        status: hit.status,
        json: async () => hit.body,
      } as any;
    }) as any;
  };

  const CONFIG = { workflows: [{ key: "requirements", stepList: STEPS.requirements.types.map(t => ({ type: t })) }] };
  const realFetch = globalThis.fetch;

  beforeEach(() => { calls.length = 0; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("forwards the CALLER's token, never a service credential", async () => {
    stub({ "/issues": { status: 200, body: [issue()] }, "/config": { status: 200, body: CONFIG } });
    await listIssues("caller-token");
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.auth).toBe("Bearer caller-token");
  });

  it("returns nothing at all without a token, rather than reaching upstream", async () => {
    // The /api gate already requires a session. This is the belt: a read that
    // fell back to SCYNE_API_TOKEN would serve one person the whole
    // organisation's issues because their cookie had expired.
    stub({ "/issues": { status: 200, body: [issue()] } });
    const r = await listIssues(null);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("filters by project and feature, which live inside params", async () => {
    stub({
      "/issues": { status: 200, body: [
        issue(), issue({ id: "i2", identifier: "SCY-9", params: { project: "RTWSA", feature: "Appeals" } }),
      ] },
      "/config": { status: 200, body: CONFIG },
    });
    const r = await listIssues("t", { project: "SAPN" });
    expect(r.data?.map(i => i.identifier)).toEqual(["SCY-3"]);
  });

  it("matches a project case-insensitively, the way a person types it", async () => {
    stub({ "/issues": { status: 200, body: [issue()] }, "/config": { status: 200, body: CONFIG } });
    expect((await listIssues("t", { project: "sapn" })).data).toHaveLength(1);
  });

  it("open means everything that has not finished either way", async () => {
    stub({
      "/issues": { status: 200, body: [
        issue({ status: "done" }), issue({ id: "i2", status: "cancelled" }),
        issue({ id: "i3", status: "blocked" }), issue({ id: "i4", status: "todo" }),
      ] },
      "/config": { status: 200, body: CONFIG },
    });
    const r = await listIssues("t", { open: true });
    expect(r.data?.map(i => i.status).sort()).toEqual(["blocked", "todo"]);
  });

  it("passes a status filter to the server, which has an index on it", async () => {
    stub({ "/issues": { status: 200, body: [] }, "/config": { status: 200, body: CONFIG } });
    await listIssues("t", { status: "blocked" });
    expect(calls.some(c => c.url.includes("/issues?status=blocked"))).toBe(true);
  });

  it("reports the orchestrator being unreachable as 503, not as an empty list", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as any;
    const r = await listIssues("t");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(r.data).toBeNull();
  });
});

describe("spend and actions preserve a refusal", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it.each([
    ["spend", () => spend("member-token", { by: "project" })],
    ["actions", () => actions("member-token")],
  ])("%s returns 403 rather than an empty table", async (_name, call) => {
    // Both are admin-only upstream. Collapsing the 403 into [] would tell a
    // member "nothing has been spent" — a confident wrong answer where "you
    // are not allowed to see this" is the true one.
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })) as any;
    const r = await call();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.data).toBeNull();
  });
});
