// The chatbot's client for @scyne/orchestrator, replacing server/paperclip.ts.
//
// Method names are deliberately unchanged from the Paperclip client: index.ts
// calls them in 33 places and none of those calls had to change. What changed is
// underneath — issues start by workflow key rather than by a title the Delivery
// Lead re-reads, gates replace interactions, agents are addressed by key rather
// than by a hired UUID, and there is no ids.json to go stale after a database
// wipe.

import * as pipeline from "../../scripts/pipeline.mjs";
import { currentToken } from "./auth.js";

const BASE = process.env.ORCHESTRATOR_API_URL || "http://127.0.0.1:3100";

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  // The token belongs to the person whose request is in flight, read from
  // AsyncLocalStorage rather than from a module global — a global would serve
  // one user's credential on another user's request as soon as two people use
  // the app at once, and that would not show up in single-user testing.
  //
  // SCYNE_API_TOKEN is the fallback for server-side work that belongs to NO
  // user: the staleness sweep, a scheduled refresh. It is never what serves a
  // browser request, because then every run would be attributed to it.
  const token = currentToken() ?? process.env.SCYNE_API_TOKEN ?? null;
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    // 401 has one cause and one fix, and the generic message sends people to
    // the orchestrator's logs instead of to their own login.
    if (res.status === 401) {
      throw new Error(
        `Orchestrator ${method} ${path} → 401. The signed-in session is not valid ` +
        `for the orchestrator — sign in again. (${text.slice(0, 200)})`);
    }
    throw new Error(`Orchestrator ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// --- title + description → workflow + params ---------------------------------
//
// index.ts builds a human-readable title and a markdown description; the
// orchestrator wants a workflow key and a flat param map. Parsing here rather
// than rewriting index.ts's five call sites keeps the swap to one file — and the
// description format is stable, being generated a few lines above each call.

/** `- ADO project: Scyne AI Project` → `adoProject: "Scyne AI Project"`. */
const PARAM_LABELS: Record<string, string> = {
  "project": "project",
  "feature": "feature",
  "feature name": "featureName",
  "artefact": "artefact",
  "process l3": "processL3",
  "process l4": "processL4",
  "starting story number": "startingStoryNumber",
  "ado parent epic id": "adoParentEpicId",
  "ado org": "adoOrg",
  "ado project": "adoProject",
  "ado wiki": "adoWiki",
  "ado work item type": "adoWorkItemType",
};

export function parseParams(description: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const line of description.split("\n")) {
    const m = /^-\s+([^:]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = PARAM_LABELS[m[1].trim().toLowerCase()];
    if (!key) continue;
    const value = m[2].trim();
    // A value WRAPPED IN PARENTHESES is index.ts's way of writing "not set":
    // "(none — create work items without a parent)", "(the project's only
    // wiki)". Passing one through literally would parent every work item under
    // an item called "(none", or send a publish looking for a wiki named "(the
    // project's only wiki)".
    //
    // Matched on the shape rather than on the words, because the words are
    // written at the call site and get reworded; the parentheses are the
    // convention. A real value never starts with "(".
    if (!value || (value.startsWith("(") && value.endsWith(")"))) continue;
    params[key] = value;
  }
  // The instruction block on a revision: everything under `## instruction` up to
  // the next heading, verbatim — the reviewer's words are the payload.
  const inst = /^##\s+instruction\s*$/im.exec(description);
  if (inst) {
    const rest = description.slice(inst.index + inst[0].length);
    const end = /^##\s+/m.exec(rest);
    const body = (end ? rest.slice(0, end.index) : rest).trim();
    if (body) params.instruction = body;
  }
  return params;
}

const STAGES = pipeline.STAGES as unknown as Record<string, { titlePrefix: string }>;

/** Title → workflow key. */
export function workflowFor(title: string, params: Record<string, string>): string {
  if (/^Revise\b/i.test(title)) {
    const stage = pipeline.stageFor(params.artefact ?? "");
    if (!stage) throw new Error(`cannot route revision '${title}': no Artefact line in the description`);
    return `revise-${stage}`;
  }
  // A republish pushes what already exists. Same shape as a revision — the
  // stage comes from the description 's Artefact line, not from the title,
  // because the title carries a human label and the label is not the key.
  if (/^Republish\b/i.test(title)) {
    const stage = pipeline.stageFor(params.artefact ?? "");
    if (!stage) throw new Error(`cannot route republish '${title}': no Artefact line in the description`);
    return `publish-${stage}`;
  }
  if (/^(Set up project|Generate project baseline)\b/i.test(title)) return "baseline";
  // Longest prefix wins: "Generate solution architecture" and "Generate
  // solution design" share their first two words, and a shorter match first
  // would route the architecture to the design stage.
  const hit = Object.entries(STAGES)
    .filter(([, def]) => def.titlePrefix && title.startsWith(def.titlePrefix))
    .sort((a, b) => b[1].titlePrefix.length - a[1].titlePrefix.length)[0];
  if (!hit) throw new Error(`cannot route issue '${title}': no stage titlePrefix matches`);
  return hit[0];
}

// --- gates, dressed as the interactions index.ts still expects ----------------

function asApproval(g: any) {
  return {
    id: g.id,
    payload: { title: g.payload?.title ?? "Approval requested", summary: g.payload?.summary ?? "" },
    status: g.status,                    // pending | approved | rejected — already the legacy vocabulary
    createdAt: g.created_at,
    decidedAt: g.decided_at ?? null,
    decisionNote: g.decision_note ?? null,
    __issueId: g.issue_id,
  };
}

export const orchestrator = {
  health: () => call("GET", "/health"),

  /**
   * `assigneeAgentId` is accepted and ignored: the workflow declares its own
   * assignee, so the chatbot and the engine cannot disagree about who owns a
   * stage. The parameter stays in the signature only so index.ts's call sites
   * do not have to change.
   */
  async createIssue(title: string, description: string, _assigneeAgentId?: string) {
    const params = parseParams(description);
    const workflow = workflowFor(title, params);
    const issue = await call<any>("POST", "/issues", { workflow, params });
    return { ...issue, title: issue.title ?? title };
  },

  /** Agents are addressed by key now. The key IS the id — nothing to look up. */
  agentId(specKey: string): string | null { return specKey || null; },
  deliveryLeadId(): string { return "pm"; },

  getIssue: (id: string) => call("GET", `/issues/${id}`),

  // ---- stopping and restarting a run ---------------------------------------
  //
  // All three return 202: a graceful pause takes effect when the step in
  // flight ends, which can be tens of minutes away. The UI polls
  // /api/status/:issueId anyway, so the status catches up on its own.

  /** `force` kills the agent now; without it, the step in flight finishes first. */
  pauseIssue: (id: string, force = false) =>
    call("POST", `/issues/${id}/pause`, force ? { force: true } : {}),

  cancelIssue: (id: string) => call("POST", `/issues/${id}/cancel`, {}),

  resumeIssue: (id: string) => call("POST", `/issues/${id}/resume`, {}),

  async getIssueByIdentifier(identifier: string) {
    const all = await call<any[]>("GET", "/issues").catch(() => [] as any[]);
    return all.filter(i => i.identifier === identifier);
  },

  listChildren: (parentId: string) =>
    call<any[]>("GET", `/issues?parentId=${parentId}`).catch(() => [] as any[]),

  listCompanyIssues: () => call<any>("GET", "/issues").catch(() => [] as any[]),

  async listIssueRuns(issueId: string) {
    const runs = await call<any[]>("GET", `/issues/${issueId}/runs`).catch(() => [] as any[]);
    // index.ts reads runId / agentId / status / startedAt / finishedAt.
    return runs.map(r => ({
      runId: r.id, id: r.id, agentId: r.agent_id, status: r.status,
      startedAt: r.started_at, finishedAt: r.finished_at, phase: r.phase,
      costUsd: r.cost_usd, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
    }));
  },

  async listAgents() {
    const agents = await call<any[]>("GET", "/agents").catch(() => [] as any[]);
    // The Live Transcript pane maps agentId → name; runs carry the agent's uuid.
    return agents.map(a => ({ ...a, id: a.id, name: a.name, key: a.key }));
  },

  getRunLog: (runId: string, offset = 0) =>
    call<{ content: string; nextOffset: number }>("GET", `/runs/${runId}/log?offset=${offset}`)
      .catch(() => ({ content: "", nextOffset: offset })),

  getRun: (runId: string) => call<any>("GET", `/runs/${runId}`).catch(() => null),

  async getInteractions(issueId: string) {
    const gates = await call<any[]>("GET", `/issues/${issueId}/gates`).catch(() => [] as any[]);
    return gates.map(asApproval);
  },

  acceptInteraction: (_issueId: string, gateId: string) =>
    call("POST", `/gates/${gateId}/approve`, { by: "chatbot" }),

  rejectInteraction: (_issueId: string, gateId: string, reason?: string) =>
    call("POST", `/gates/${gateId}/reject`, { by: "chatbot", ...(reason ? { note: reason } : {}) }),

  /**
   * A no-op, kept so index.ts's two call sites still compile. Paperclip needed
   * an explicit wake after an approval because its auto-wake was unreliable; the
   * engine advances the issue inside decideGate, before the approve request
   * returns.
   */
  async wakeAgent(_agentId: string, _reason: string) { return { ok: true, noop: true }; },

  /** index.ts sets `todo` to re-fire a stalled issue. That is now an explicit resume. */
  async setIssueStatus(issueId: string, status: string) {
    if (status === "todo") return call("POST", `/issues/${issueId}/advance`);
    return call("PATCH", `/issues/${issueId}`, { status });
  },

  getComments: (issueId: string) => call("GET", `/issues/${issueId}/comments`),
  addComment: (issueId: string, body: string) =>
    call("POST", `/issues/${issueId}/comments`, { body, authorUser: "chatbot" }),
  getWorkProducts: (issueId: string) => call("GET", `/issues/${issueId}/work-products`),

  /**
   * Null for a root that does not exist, rather than throwing. A browser can
   * hold a `scyne_parent_issue_id` from a previous database — every Paperclip-era
   * id is one — and the caller needs to answer "that session is gone" rather
   * than 500 every three seconds forever.
   */
  async getIssueTree(rootId: string): Promise<any> {
    const root = await this.getIssue(rootId).catch(() => null);
    if (!root) return null;
    const [children, comments, approvals, workProducts] = await Promise.all([

      this.listChildren(rootId),
      this.getComments(rootId).catch(() => []),
      this.getInteractions(rootId).catch(() => []),
      this.getWorkProducts(rootId).catch(() => []),
    ]);
    const childTrees = await Promise.all((children as any[]).map(c => this.getIssueTree(c.id)));
    return { ...(root as object), comments, approvals, workProducts, children: childTrees };
  },
};
