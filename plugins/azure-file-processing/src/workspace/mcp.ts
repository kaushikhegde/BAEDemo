import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OrchCtx } from "./orchestrator.js";
import { startStage, WORKFLOW_KEYS } from "./tools/start-stage.js";
import { issueStatus } from "./tools/issue-status.js";
import { attachDocument } from "./tools/attach-document.js";
import { listIssues } from "./tools/list-issues.js";
import { approveGate, rejectGate } from "./tools/gates.js";
import { pauseIssue, resumeIssue } from "./tools/control.js";
import { spend } from "./tools/spend.js";
import {
  createProject, createFeature, listProjects, listFeatures, listDocuments,
} from "./tools/workspace.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  [k: string]: unknown;
};

export const jsonResult = (value: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/**
 * MCP server 2 — a front door to the Scyne stack (orchestrator + chatbot),
 * so a stage started from Codex is the same tracked issue a stage started
 * from the chatbot is. Fourteen tools: `start_stage`, `issue_status`,
 * `attach_document`, `list_issues`, `approve_gate`, `reject_gate`,
 * `pause_issue`, `resume_issue`, `spend`, `create_project`,
 * `create_feature`, `list_projects`, `list_features`, `list_documents`.
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

  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description:
        "Every tracked issue, optionally narrowed by project, feature, status or `open` " +
        "(todo/in_progress/in_review/blocked/paused). Each row carries `needsHuman` — true " +
        "when it is parked at a gate, blocked, or paused and waiting on a person.",
      inputSchema: {
        project: z.string().optional(),
        feature: z.string().optional(),
        status: z.string().optional(),
        open: z.boolean().optional(),
      },
    },
    async (args) => jsonResult(await listIssues(ctx, args as any)),
  );

  server.registerTool(
    "approve_gate",
    {
      title: "Approve a gate",
      description:
        "Approve a pending human approval gate. The issue resumes in the background — the " +
        "publish step (a wiki page, a backlog) runs immediately after. Never approve on the " +
        "person's behalf; report what is waiting and let them decide.",
      inputSchema: { gateId: z.string().min(1) },
    },
    async (args) => jsonResult(await approveGate(ctx, args as any)),
  );

  server.registerTool(
    "reject_gate",
    {
      title: "Reject a gate",
      description:
        "Reject a pending gate. This REWINDS the issue to the step that generated the " +
        "artefact and REGENERATES it — not a simple decline. `note` is required: it is the " +
        "only thing the agent is given to know what to fix.",
      inputSchema: { gateId: z.string().min(1), note: z.string().min(1) },
    },
    async (args) => jsonResult(await rejectGate(ctx, args as any)),
  );

  server.registerTool(
    "pause_issue",
    {
      title: "Pause an issue",
      description:
        "Request a pause. Plain pause lets the step in flight finish first and parks before " +
        "the next one; `force: true` sends SIGTERM/SIGKILL to the agent NOW, losing that " +
        "step's work — that step re-runs on resume. A request, honoured at the engine's next " +
        "step boundary, not an instant status change.",
      inputSchema: { issueId: z.string().min(1), force: z.boolean().optional() },
    },
    async (args) => jsonResult(await pauseIssue(ctx, args as any)),
  );

  server.registerTool(
    "resume_issue",
    {
      title: "Resume an issue",
      description:
        "Resume a paused or blocked issue at the step it stopped at. Steps that already " +
        "succeeded are not re-run.",
      inputSchema: { issueId: z.string().min(1) },
    },
    async (args) => jsonResult(await resumeIssue(ctx, args as any)),
  );

  server.registerTool(
    "spend",
    {
      title: "Spend report",
      description:
        "Token and dollar spend grouped by project, feature, user, agent, adapter or model. " +
        "Admin-only upstream — a refusal is reported as a refusal, never as an empty table.",
      inputSchema: {
        by: z.enum(["project", "feature", "user", "agent", "adapter", "model"]),
      },
    },
    async (args) => jsonResult(await spend(ctx, args as any)),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description:
        "Create a Scyne project: the folder tree, the database row, its Azure DevOps " +
        "project and its branding, in one call. A name with spaces is SLUGGED — the " +
        "result reports the name it actually used. Reports `dbError` and `adoError` " +
        "separately: either can fail while the project is still usable.",
      inputSchema: {
        project: z.string().min(1),
        description: z.string().optional(),
        website: z.string().optional(),
      },
    },
    async (args) => jsonResult(await createProject(ctx, args as any)),
  );

  server.registerTool(
    "create_feature",
    {
      title: "Create a feature",
      description:
        "Create a feature under a project, on disk and in the database. Feature names " +
        "may contain spaces. Reserved names (capabilities, personas, app, all, baseline, " +
        "solutions, documents, design, original-files, outputs) are refused.",
      inputSchema: { project: z.string().min(1), feature: z.string().min(1) },
    },
    async (args) => jsonResult(await createFeature(ctx, args as any)),
  );

  server.registerTool(
    "list_projects",
    { title: "List projects", description: "Every project on the workspace.", inputSchema: {} },
    async () => jsonResult(await listProjects(ctx)),
  );

  server.registerTool(
    "list_features",
    {
      title: "List features",
      description: "The features under one project.",
      inputSchema: { project: z.string().min(1) },
    },
    async (args) => jsonResult(await listFeatures(ctx, args as any)),
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description:
        "Documents at both levels, each with `inDb`. A row with `inDb: false` is on disk " +
        "and absent from the database — real and fixable, so it is reported rather than " +
        "hidden. Also returns the artefacts that now predate their inputs.",
      inputSchema: { project: z.string().min(1), feature: z.string().optional() },
    },
    async (args) => jsonResult(await listDocuments(ctx, args as any)),
  );

  return server;
};
