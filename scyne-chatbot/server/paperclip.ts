import { readFileSync } from "node:fs";
import path from "node:path";
import { WORKSPACE_PATH } from "./workspace.js";

const BASE = process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100/api";

// Single source of truth for company + agent IDs is .bootstrap/ids.json, written
// by scripts/bootstrap.mjs after hiring agents. We deliberately do NOT fall back
// to .env values — a stale .env after a DB wipe is the exact bug this avoids.
// If ids.json is missing, instruct the user to run bootstrap rather than silently
// pointing at non-existent UUIDs.
const IDS_PATH = process.env.BOOTSTRAP_IDS_PATH
  || path.join(WORKSPACE_PATH, ".bootstrap", "ids.json");
let COMPANY = "";
let DELIVERY_LEAD_AGENT = "";
try {
  const ids = JSON.parse(readFileSync(IDS_PATH, "utf8"));
  COMPANY = ids.companyId || "";
  DELIVERY_LEAD_AGENT = ids.deliveryLeadAgentId || "";
  if (!COMPANY || !DELIVERY_LEAD_AGENT) {
    throw new Error(`ids.json present but missing companyId/deliveryLeadAgentId`);
  }
  console.log(`[paperclip] using ids from ${IDS_PATH}: company=${COMPANY} deliveryLead=${DELIVERY_LEAD_AGENT}`);
} catch (e: any) {
  console.error(
    `[paperclip] FATAL: cannot read ${IDS_PATH} (${e?.message ?? e}).\n` +
    `Run \`npm run bootstrap\` to hire agents and produce this file.`,
  );
  // Don't crash the dev server — the chatbot can boot and serve the UI;
  // requests that need these IDs will fail with a clear message at call time.
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paperclip ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const paperclip = {
  health: () => call("GET", "/health"),

  createIssue(title: string, description: string) {
    return call("POST", `/companies/${COMPANY}/issues`, {
      title,
      description,
      assigneeAgentId: DELIVERY_LEAD_AGENT,
      status: "todo",
      priority: "medium",
    });
  },

  getIssue(id: string) {
    return call("GET", `/issues/${id}`);
  },

  getIssueByIdentifier(identifier: string) {
    return call("GET", `/companies/${COMPANY}/issues?identifier=${identifier}`);
  },

  // Children are listed via the company issues endpoint with a parentId filter.
  // The endpoint /issues/:id/children does NOT exist in Paperclip.
  listChildren(parentId: string) {
    return call<any[]>("GET", `/companies/${COMPANY}/issues?parentId=${parentId}`).catch(() => [] as any[]);
  },

  // All issues in the company (no parentId filter). Used by the History view.
  listCompanyIssues() {
    return call<any>("GET", `/companies/${COMPANY}/issues`).catch(() => [] as any[]);
  },

  // Agent run timeline — used for the compact run-summary lines in Activity.
  listIssueRuns(issueId: string) {
    return call<any>("GET", `/issues/${issueId}/runs`).catch(() => [] as any[]);
  },
  listAgents() {
    return call<any>("GET", `/companies/${COMPANY}/agents`).catch(() => [] as any[]);
  },

  // Fetch a chunk of a heartbeat-run's raw stdout log starting at byte offset.
  // Returns Paperclip's shape: { content: string, nextOffset: number }.
  // The Live Transcript pane polls this every 3s with the previous nextOffset.
  getRunLog(runId: string, offset = 0, limitBytes = 65536) {
    return call<{ content: string; nextOffset: number }>(
      "GET",
      `/heartbeat-runs/${runId}/log?offset=${offset}&limitBytes=${limitBytes}`,
    ).catch(() => ({ content: "", nextOffset: offset }));
  },

  // One heartbeat-run's metadata (status, startedAt/finishedAt, agentId).
  getRun(runId: string) {
    return call<any>("GET", `/heartbeat-runs/${runId}`).catch(() => null);
  },

  // Paperclip 2026.525+ renamed approvals to "interactions". We fetch the new
  // shape and normalise into the legacy approval shape downstream code expects.
  // Mapping:
  //   interaction.id                → approval.id
  //   interaction.payload.prompt    → approval.payload.title  (the human-facing text)
  //   interaction.status "accepted" → approval.status "approved"   (other statuses pass through)
  //   interaction.resolvedAt        → approval.decidedAt
  //   interaction.result?.reason    → approval.decisionNote
  // Extra carry-fields (__interaction, __kind) let callers route resolution correctly.
  async getInteractions(issueId: string): Promise<any[]> {
    const raw = await call<any[]>("GET", `/issues/${issueId}/interactions`).catch(() => [] as any[]);
    return (Array.isArray(raw) ? raw : []).map((it) => ({
      id: it.id,
      payload: {
        title: it.payload?.prompt ?? it.title ?? "Approval requested",
        summary: it.payload?.summary ?? it.summary ?? "",
      },
      status: it.status === "accepted" ? "approved" : it.status,
      createdAt: it.createdAt,
      decidedAt: it.resolvedAt ?? null,
      decisionNote: it.result?.reason ?? null,
      // Carry the originals so resolution + debugging works:
      __interaction: true,
      __kind: it.kind,
      __issueId: it.issueId,
      __raw: it,
    }));
  },

  // Accept (approve) an interaction. Requires both the issue id and interaction id —
  // the /interactions/:id endpoint is nested under the issue.
  acceptInteraction(issueId: string, interactionId: string) {
    return call("POST", `/issues/${issueId}/interactions/${interactionId}/accept`, {});
  },

  // Force an agent run. Paperclip's auto-wake on interaction-accept is unreliable
  // in 2026.525; the chatbot calls this explicitly after acceptInteraction so the
  // BA picks up Phase 2 immediately without depending on heartbeat or queue drain.
  // forceFreshSession bypasses any cached Claude session state.
  wakeAgent(agentId: string, reason: string) {
    return call("POST", `/agents/${agentId}/wakeup`, {
      reason,
      forceFreshSession: true,
    });
  },

  // Reject an interaction with an optional reason (used for both hard-reject and
  // request-changes — request-changes ALSO posts a comment + flips status to todo).
  rejectInteraction(issueId: string, interactionId: string, reason?: string) {
    return call("POST", `/issues/${issueId}/interactions/${interactionId}/reject`, {
      ...(reason ? { reason } : {}),
    });
  },

  // Flip an issue's status. Setting it to "todo" re-fires the assignee agent
  // (Paperclip does NOT auto-wake on reject/revision, so this is the re-trigger).
  setIssueStatus(issueId: string, status: string) {
    return call("PATCH", `/issues/${issueId}`, { status });
  },

  getComments(issueId: string) {
    return call("GET", `/issues/${issueId}/comments`);
  },

  addComment(issueId: string, body: string) {
    return call("POST", `/issues/${issueId}/comments`, { body });
  },

  getWorkProducts(issueId: string) {
    return call("GET", `/issues/${issueId}/work-products`);
  },

  // Recursive: parent → children → grandchildren etc. Folds in comments + interactions (normalised
  // into approval shape for back-compat) + work-products. The `approvals` field on each node is
  // populated from /interactions — the legacy /approvals endpoint is empty on Paperclip 2026.525+.
  async getIssueTree(rootId: string): Promise<any> {
    const [root, children, comments, approvals, workProducts] = await Promise.all([
      this.getIssue(rootId),
      this.listChildren(rootId),
      this.getComments(rootId).catch(() => []),
      this.getInteractions(rootId).catch(() => []),
      this.getWorkProducts(rootId).catch(() => []),
    ]);
    const childTrees = await Promise.all((children as any[]).map((c) => this.getIssueTree(c.id)));
    return {
      ...root,
      comments,
      approvals,
      workProducts,
      children: childTrees,
    };
  },
};
