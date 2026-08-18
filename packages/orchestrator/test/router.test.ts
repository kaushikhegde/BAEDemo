import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOrchestrator, type Orchestrator } from "../src/index.js";
import { defineOrchestrator } from "../src/config.js";
import { createRouter } from "../src/http/router.js";

// The same fake-runner-through-the-adapter-registry pattern engine.test.ts
// uses: the fake is injected via config.adapters.claude_local so a request
// through the router exercises the real resolveRuntime → config.adapters
// path, and no `claude` process or shell is ever spawned.
const fakeRunner = {
  run: async () => ({
    exitCode: 0, status: "succeeded" as const, stderrTail: "",
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
             costUsd: 0.01, durationMs: 100, numTurns: 1, sessionId: "s" },
  }),
};

function config(workspace: string) {
  return defineOrchestrator({
    workspace,
    db: { driver: "pglite", dir: join(workspace, "pg") },
    adapters: { claude_local: fakeRunner },
    defaults: { adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" },
    org: [{ key: "ba", name: "BA", title: "Business Analyst" }],
    workflows: [{
      key: "requirements", label: "Requirements", assignee: "ba",
      steps: [
        { type: "agent", phase: "generate" },
        { type: "gate",  title: "Approve Requirements" },
      ],
    }],
  });
}

let dir: string;
let orch: Orchestrator;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-http-"));
  orch = await createOrchestrator(config(dir));

  const app = express();
  app.use(express.json());
  app.use(createRouter(orch));

  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await orch.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Creates the issue via the real HTTP route, then forces the SAME engine
 * instance to finish advancing before returning — the route itself fires
 * `engine.advance()` without awaiting it (so the 201 response isn't held up
 * by a slow agent run), which is deliberately racy for a caller that only
 * has the HTTP surface. Tests want a settled state to assert against, and can
 * reach past HTTP into the engine directly because they hold `orch` too;
 * `advance()` is idempotent (per-issue lock, then a status/step check), so
 * this never double-runs the step the fire-and-forget call already did. */
async function createAndSettle(params: Record<string, string> = { project: "P" }) {
  const res = await fetch(`${baseUrl}/issues`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow: "requirements", params }),
  });
  const issue = await res.json();
  await orch.engine.advance(issue.id);
  return { createRes: res, issue };
}

describe("router", () => {
  it("GET /health returns 200 with a Postgres version", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.db).toMatch(/PostgreSQL/);
    expect(typeof body.claude).toBe("string");
  });

  it("POST /issues returns 201 with an identifier, and GET /issues/:id round-trips", async () => {
    const { createRes, issue } = await createAndSettle({ project: "RTWSA" });
    expect(createRes.status).toBe(201);
    expect(issue.identifier).toMatch(/^SCY-\d+$/);

    const got = await fetch(`${baseUrl}/issues/${issue.id}`);
    expect(got.status).toBe(200);
    const gotIssue = await got.json();
    expect(gotIssue.id).toBe(issue.id);
    expect(gotIssue.params.project).toBe("RTWSA");
    // Settled past the agent step onto the gate.
    expect(gotIssue.status).toBe("in_review");
  });

  it("survives (and logs) engine.advance() rejecting after the 201 has already gone out", async () => {
    // Reproduces the fix-round-1 finding: engine.ts's advance() only wraps
    // its runStep() call in try/catch — the surrounding repo.getIssue(),
    // workflow() lookup, and the post-step repo.updateIssue(..., {status:
    // "in_progress"}) are all OUTSIDE it. router.ts fires advance() without
    // awaiting it (so a slow agent run doesn't hold up the 201), so a
    // transient failure in any of those calls used to become an unhandled
    // promise rejection with no .catch() anywhere — which is fatal by
    // Node's default since v15.
    //
    // engine.ts is frozen for this fix — not editable — so the repro
    // monkey-patches `orch.repo.updateIssue` (a plain object method, not a
    // class) to throw exactly once: the FIRST call to it in this test's
    // 2-step workflow is precisely that post-agent-step transition, since
    // engine.start() only calls repo.createIssue() and the agent step
    // itself never calls updateIssue.
    const originalUpdateIssue = orch.repo.updateIssue.bind(orch.repo);
    let updateCalls = 0;
    orch.repo.updateIssue = async (id, patch) => {
      updateCalls += 1;
      if (updateCalls === 1) throw new Error("SIMULATED_TRANSIENT_DB_FAILURE");
      return originalUpdateIssue(id, patch);
    };

    // This test runs the Express app IN-PROCESS with vitest itself (no child
    // process) — so if router.ts genuinely has no .catch() on the
    // fire-and-forget advance() call, Node's default unhandled-rejection
    // behaviour would kill the WHOLE vitest worker, not just fail an
    // assertion. Node only applies that default when a `rejection` has ZERO
    // listeners, so installing our own listener here is what makes it safe
    // to run this repro at all — and its content is exactly the signal that
    // would otherwise have been fatal: an unhandled rejection reaching
    // process level proves router.ts failed to catch it.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (err: unknown): void => { unhandled.push(err); };
    process.on("unhandledRejection", onUnhandledRejection);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const res = await fetch(`${baseUrl}/issues`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: "requirements", params: { project: "P" } }),
      });
      // The client already sees success — that half of the bug report is
      // unchanged and is not what this test is about.
      expect(res.status).toBe(201);
      const issue = await res.json();

      // Give the fire-and-forget advance() call's rejection a turn to
      // surface before asserting on it.
      await new Promise(r => setTimeout(r, 50));

      // The fix: router.ts's own .catch() consumes the rejection before it
      // ever reaches process level, so our listener above must never fire.
      expect(unhandled).toEqual([]);
      // "Log it rather than swallowing it silently" — an operator needs to
      // know the issue stopped progressing.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`advance(${issue.id})`), expect.any(Error));

      // The proof the process (and this Express app inside it) is still
      // alive: it answers a completely unrelated subsequent request.
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      errorSpy.mockRestore();
      orch.repo.updateIssue = originalUpdateIssue;
    }
  });

  it("GET /issues lists and filters by status", async () => {
    await createAndSettle();
    const all = await fetch(`${baseUrl}/issues`).then(r => r.json());
    expect(all.length).toBeGreaterThanOrEqual(1);

    const inReview = await fetch(`${baseUrl}/issues?status=in_review`).then(r => r.json());
    expect(inReview.every((i: { status: string }) => i.status === "in_review")).toBe(true);

    const none = await fetch(`${baseUrl}/issues?status=done`).then(r => r.json());
    expect(none.some((i: { status: string }) => i.status === "in_review")).toBe(false);
  });

  it("POST /issues 400s when workflow is missing or unknown", async () => {
    const missing = await fetch(`${baseUrl}/issues`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const unknown = await fetch(`${baseUrl}/issues`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "does-not-exist" }),
    });
    expect(unknown.status).toBe(400);
  });

  it("lists and fetches agents, and PATCH updates adapter/model/effort/budget", async () => {
    const list = await fetch(`${baseUrl}/agents`).then(r => r.json());
    expect(list.map((a: { key: string }) => a.key)).toContain("ba");

    const one = await fetch(`${baseUrl}/agents/ba`);
    expect(one.status).toBe(200);
    const agent = await one.json();
    expect(agent.name).toBe("BA");

    const patchRes = await fetch(`${baseUrl}/agents/ba`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-6", effort: "high", budget: { maxCostUsd: 5 } }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.model).toBe("claude-opus-4-6");
    expect(patched.effort).toBe("high");
    // Untouched fields survive the patch.
    expect(patched.name).toBe("BA");
    expect(patched.title).toBe("Business Analyst");

    const badEffort = await fetch(`${baseUrl}/agents/ba`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort: "nonsense" }),
    });
    expect(badEffort.status).toBe(400);
  });

  it("GET /runners lists the registered adapter keys", async () => {
    const runners = await fetch(`${baseUrl}/runners`).then(r => r.json());
    expect(runners).toEqual(["claude_local"]);
  });

  it("raises a gate, lists it, records a comment, and approving resumes the workflow to done", async () => {
    const { issue } = await createAndSettle();

    const gates = await fetch(`${baseUrl}/issues/${issue.id}/gates`).then(r => r.json());
    expect(gates).toHaveLength(1);
    expect(gates[0].status).toBe("pending");
    expect(gates[0].payload.title).toBe("Approve Requirements");

    const commentRes = await fetch(`${baseUrl}/issues/${issue.id}/comments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Looks good.", authorUser: "tagari" }),
    });
    expect(commentRes.status).toBe(201);
    const comments = await fetch(`${baseUrl}/issues/${issue.id}/comments`).then(r => r.json());
    expect(comments.map((c: { body: string }) => c.body)).toContain("Looks good.");

    const commentMissingBody = await fetch(`${baseUrl}/issues/${issue.id}/comments`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(commentMissingBody.status).toBe(400);

    const approveRes = await fetch(`${baseUrl}/gates/${gates[0].id}/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "Ship it.", by: "tagari" }),
    });
    // 202, not 200: the decision is durable before the response goes out, but
    // the resume runs in the background — awaiting it would hold the connection
    // open for a whole publish step.
    expect(approveRes.status).toBe(202);
    expect((await approveRes.json()).ok).toBe(true);

    // The 2-step workflow (agent, gate) has nothing left after the gate.
    await vi.waitFor(async () => {
      const after = await fetch(`${baseUrl}/issues/${issue.id}`).then(r => r.json());
      expect(after.status).toBe("done");
    });
  });

  it("a rejected gate rewinds to the generating step and regenerates", async () => {
    const { issue } = await createAndSettle();
    const gates = await fetch(`${baseUrl}/issues/${issue.id}/gates`).then(r => r.json());

    const rejectRes = await fetch(`${baseUrl}/gates/${gates[0].id}/reject`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "Wrong personas." }),
    });
    expect(rejectRes.status).toBe(202);

    // A rejection used to leave the issue at `todo` with nothing watching for
    // it — a dead end for both Reject and Request-changes. It now regenerates
    // (in the background) and comes back to a fresh gate.
    await vi.waitFor(async () => {
      const after = await fetch(`${baseUrl}/issues/${issue.id}`).then(r => r.json());
      expect(after.status).toBe("in_review");
      expect(after.step_index).toBe(1);
    });
    const now = await fetch(`${baseUrl}/issues/${issue.id}/gates`).then(r => r.json());
    expect(now.filter((g: { status: string }) => g.status === "pending")).toHaveLength(1);
    expect(now.filter((g: { status: string }) => g.status === "rejected")).toHaveLength(1);
  });

  it("POST /issues/:id/advance resumes an issue, and 404s for an unknown one", async () => {
    const { issue } = await createAndSettle();

    const res = await fetch(`${baseUrl}/issues/${issue.id}/advance`, { method: "POST" });
    expect(res.status).toBe(202);
    expect((await res.json()).ok).toBe(true);

    const missing = await fetch(
      `${baseUrl}/issues/11111111-1111-4111-8111-111111111111/advance`, { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("lists runs for an issue and for its agent, and serves the log and transcript", async () => {
    const { issue } = await createAndSettle();

    const issueRuns = await fetch(`${baseUrl}/issues/${issue.id}/runs`).then(r => r.json());
    expect(issueRuns).toHaveLength(1);
    const run = issueRuns[0];
    expect(run.status).toBe("succeeded");

    const agentRuns = await fetch(`${baseUrl}/agents/ba/runs`).then(r => r.json());
    expect(agentRuns.map((rr: { id: string }) => rr.id)).toContain(run.id);

    const runGet = await fetch(`${baseUrl}/runs/${run.id}`);
    expect(runGet.status).toBe(200);

    // The fake runner never wrote a log file (that's the real runner's job —
    // see src/core/runner.ts), so before one exists on disk the endpoints
    // report 404 rather than a raw ENOENT-shaped 500.
    const missingLog = await fetch(`${baseUrl}/runs/${run.id}/log`);
    expect(missingLog.status).toBe(404);

    // Write the JSONL a real run would have produced, in the {ts, stream,
    // chunk} outer envelope filterRunLog() expects, and confirm both
    // endpoints read it back correctly.
    mkdirSync(dirname(run.log_path), { recursive: true });
    const innerEvent = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello from the agent" }] } });
    writeFileSync(run.log_path, JSON.stringify({ ts: new Date().toISOString(), stream: "stdout", chunk: innerEvent + "\n" }) + "\n");

    const logBody = await fetch(`${baseUrl}/runs/${run.id}/log`).then(r => r.json());
    expect(logBody.content).toContain("hello from the agent");
    expect(logBody.nextOffset).toBeGreaterThan(0);

    const transcriptBody = await fetch(`${baseUrl}/runs/${run.id}/transcript`).then(r => r.json());
    expect(transcriptBody.events.some(
      (e: { kind: string; text?: string }) => e.kind === "assistant" && e.text?.includes("hello from the agent"),
    )).toBe(true);
  });

  it("aggregates usage across runs", async () => {
    await createAndSettle();
    const usage = await fetch(`${baseUrl}/usage`).then(r => r.json());
    expect(usage.runCount).toBeGreaterThanOrEqual(1);
    expect(usage.inputTokens).toBeGreaterThanOrEqual(10);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(20);
    expect(typeof usage.costUsd).toBe("number");
  });

  it("GET /config returns a sanitised summary, never the raw adapter instances", async () => {
    const cfg = await fetch(`${baseUrl}/config`).then(r => r.json());
    expect(cfg.workspace).toBe(dir);
    expect(cfg.company).toBe("Scyne");
    expect(cfg.adapters).toEqual(["claude_local"]);
    expect(cfg.theme.brand).toBe("#464E7E");
    expect(cfg.workflows.find((w: { key: string }) => w.key === "requirements").steps).toBe(2);
    expect(cfg).not.toHaveProperty("db"); // no connection details leaked
  });

  it("404s for unknown agents, issues, runs and gates", async () => {
    const nilId = "00000000-0000-0000-0000-000000000000";
    expect((await fetch(`${baseUrl}/agents/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/issues/${nilId}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/runs/${nilId}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/gates/${nilId}/approve`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${baseUrl}/gates/${nilId}/reject`, { method: "POST" })).status).toBe(404);
  });

  it("serves /openapi.json and a self-contained /docs page with no external references", async () => {
    const specRes = await fetch(`${baseUrl}/openapi.json`);
    expect(specRes.status).toBe(200);
    expect(specRes.headers.get("content-type")).toMatch(/json/);
    const spec = await specRes.json();
    expect(spec.info.title).toBe("Scyne Orchestrator");
    expect(Object.keys(spec.paths).length).toBeGreaterThan(15);

    const docsRes = await fetch(`${baseUrl}/docs`);
    expect(docsRes.status).toBe(200);
    expect(docsRes.headers.get("content-type")).toMatch(/html/);
    const html = await docsRes.text();
    expect(html).toContain("Scyne Orchestrator");
    expect(html).toContain("--brand: #464E7E;");
    expect(html).toContain("GET"); // at least one method badge rendered
    expect(html).toContain("/health");
    // Zero network requests: no CDN scripts, no external stylesheets/fonts.
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link[^>]*\shref=/i);
    expect(html).not.toMatch(/@import|https?:\/\/|url\(/);
  });
});

describe("router: console and bundles", () => {
  it("serves the console at /orch", async () => {
    const res = await fetch(`${baseUrl}/orch`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Orchestrator");
    expect(body).not.toMatch(/<script[^>]+src=/);
  });

  it("serves an agent's bundle, and 404s for an unknown agent", async () => {
    const declaredNone = await (await fetch(`${baseUrl}/agents/ba/bundle`)).json();
    expect(declaredNone.path).toBe(null);     // the test org declares no bundlePath
    expect(declaredNone.content).toBe("");

    expect((await fetch(`${baseUrl}/agents/nope/bundle`)).status).toBe(404);
  });
});

