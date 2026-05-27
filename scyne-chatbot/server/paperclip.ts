import { readFileSync } from "node:fs";

const BASE = process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100/api";

// IDs come from env, but the Docker stack provisions agents at runtime (Paperclip
// generates its own UUIDs), so prefer the bootstrap-written ids.json when present.
let COMPANY = process.env.PAPERCLIP_COMPANY_ID || "";
let PM_AGENT = process.env.PAPERCLIP_PM_AGENT_ID || "";
try {
  const idsPath = process.env.BOOTSTRAP_IDS_PATH
    || `${process.env.WORKSPACE_PATH || "/workspace"}/.bootstrap/ids.json`;
  const ids = JSON.parse(readFileSync(idsPath, "utf8"));
  if (ids.companyId) COMPANY = ids.companyId;
  if (ids.pmAgentId) PM_AGENT = ids.pmAgentId;
  console.log(`[paperclip] using ids from ${idsPath}: company=${COMPANY} pm=${PM_AGENT}`);
} catch {
  /* no ids.json (non-Docker dev) — fall back to env */
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
      assigneeAgentId: PM_AGENT,
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

  getApprovals(issueId: string) {
    return call("GET", `/issues/${issueId}/approvals`);
  },

  approveGate(approvalId: string, note?: string) {
    return call("POST", `/approvals/${approvalId}/approve`, { decisionNote: note ?? "Approved via Scyne chatbot." });
  },

  rejectGate(approvalId: string, note?: string) {
    return call("POST", `/approvals/${approvalId}/reject`, { decisionNote: note ?? "Rejected via Scyne chatbot." });
  },

  // Send the gate back for changes (keeps it "live", records the feedback as decisionNote).
  requestRevision(approvalId: string, note: string) {
    return call("POST", `/approvals/${approvalId}/request-revision`, { decisionNote: note });
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

  // Recursive: parent → children → grandchildren etc. Now also folds in comments + approvals + work-products.
  async getIssueTree(rootId: string): Promise<any> {
    const [root, children, comments, approvals, workProducts] = await Promise.all([
      this.getIssue(rootId),
      this.listChildren(rootId),
      this.getComments(rootId).catch(() => []),
      this.getApprovals(rootId).catch(() => []),
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
