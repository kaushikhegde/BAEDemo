const BASE = process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100/api";
const COMPANY = process.env.PAPERCLIP_COMPANY_ID!;
const PM_AGENT = process.env.PAPERCLIP_PM_AGENT_ID!;

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

  getApprovals(issueId: string) {
    return call("GET", `/issues/${issueId}/approvals`);
  },

  approveGate(approvalId: string, note?: string) {
    return call("POST", `/approvals/${approvalId}/approve`, { decisionNote: note ?? "Approved via Scyne chatbot." });
  },

  rejectGate(approvalId: string, note?: string) {
    return call("POST", `/approvals/${approvalId}/reject`, { decisionNote: note ?? "Rejected via Scyne chatbot." });
  },

  getComments(issueId: string) {
    return call("GET", `/issues/${issueId}/comments`);
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
