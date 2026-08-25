import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OrchCtx } from "./orchestrator.js";
import { startStage, WORKFLOW_KEYS } from "./tools/start-stage.js";
import { issueStatus } from "./tools/issue-status.js";
import { attachDocument } from "./tools/attach-document.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  [k: string]: unknown;
};

export const jsonResult = (value: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/**
 * MCP server 2 — the thin vertical slice. Just enough to attach a document,
 * fire a pipeline stage, and poll it: `attach_document`, `start_stage`,
 * `issue_status`. Deliberately no gates, control, spend, listings,
 * create_project/create_feature — see the task brief for why.
 */
export const buildWorkspaceServer = (ctx: OrchCtx): McpServer => {
  const server = new McpServer({ name: "scyne-workspace", version: "0.1.0" });

  server.registerTool(
    "start_stage",
    {
      title: "Start a pipeline stage",
      description:
        `Start one Scyne pipeline stage. It becomes a tracked issue, exactly as if it had ` +
        `been started from the chatbot — visible in the console, Spend and Actions. ` +
        `Returns immediately with an issue id; poll issue_status. Workflows: ${WORKFLOW_KEYS.join(", ")}.`,
      inputSchema: {
        workflow: z.enum(WORKFLOW_KEYS as unknown as [string, ...string[]]),
        project: z.string().min(1),
        feature: z.string().optional(),
      },
    },
    async (args) => jsonResult(await startStage(ctx, args as any)),
  );

  server.registerTool(
    "issue_status",
    {
      title: "Issue status",
      description:
        "State, current step, any pending approval gate, and the recent activity timeline for one issue.",
      inputSchema: { issueId: z.string().min(1) },
    },
    async (args) => jsonResult(await issueStatus(ctx, args as any)),
  );

  server.registerTool(
    "attach_document",
    {
      title: "Attach a document",
      description:
        "Upload a document from a LOCAL PATH into a project or a feature. It is converted " +
        "to markdown on arrival and the source archived, so the reported filename is often " +
        "not the one you passed. `kind` names the folder for a feature-level document " +
        "(sop · transcripts · notes · ui) and avoids an ambiguous-kind refusal. Also pushes " +
        "the result to Azure Blob.",
      inputSchema: {
        project: z.string().min(1),
        feature: z.string().optional(),
        path: z.string().min(1),
        kind: z.enum(["sop", "transcripts", "notes", "ui"]).optional(),
      },
    },
    async (args) => jsonResult(await attachDocument(ctx, args as any)),
  );

  return server;
};
