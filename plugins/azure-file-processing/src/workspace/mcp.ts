import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerPrompts } from "./prompts.js";
import type { OrchCtx } from "./orchestrator.js";
import { startStage, stages } from "./tools/start-stage.js";
import { issueStatus } from "./tools/issue-status.js";
import { attachDocument } from "./tools/attach-document.js";
import { listIssues } from "./tools/list-issues.js";
import { approveGate, rejectGate } from "./tools/gates.js";
import { pauseIssue, resumeIssue } from "./tools/control.js";
import { spend } from "./tools/spend.js";
import {
  createProject, createFeature, listProjects, listFeatures, listDocuments,
} from "./tools/workspace.js";
import { ingestDocument } from "./tools/ingest-document.js";
import {
  reviseArtefact, republishArtefact, getProjectDefinition, saveProjectDefinition,
  staleness, extractBrand, ARTEFACTS,
} from "./tools/artefacts.js";
import {
  deleteDocument, replaceDocument, readDocument, extractStatus,
} from "./tools/documents.js";
import {
  cancelIssue, issueRuns, runTranscript, actions, history, requestChanges,
} from "./tools/observe.js";

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
 * from the chatbot is.
 *
 * Thirty-two tools, covering what the web chat and the `scyne` CLI can each
 * do, so a person working from Codex is not driven back to a browser for an
 * ordinary operation:
 *
 *   documents   ingest_document · attach_document · read_document ·
 *               replace_document · delete_document · list_documents ·
 *               extract_status
 *   pipeline    stages · start_stage · revise_artefact · republish_artefact ·
 *               staleness
 *   gates       approve_gate · reject_gate · request_changes
 *   issues      issue_status · list_issues · pause_issue · resume_issue ·
 *               cancel_issue · issue_runs · run_transcript
 *   workspace   create_project · create_feature · list_projects ·
 *               list_features · get_project_definition ·
 *               save_project_definition · extract_brand
 *   reporting   spend · actions · history
 *
 * The count is asserted by test/workspace-tools.test.ts against this list, so
 * a tool added without a line here fails the build rather than going
 * undocumented.
 *
 * Deliberately NOT covered: organisations, users, members, model prices and
 * installations. Those are installation administration, they are guarded by
 * role upstream, and the console is the right surface for them — a plugin that
 * can re-price every run in the install is not a document tool.
 */
export const buildWorkspaceServer = (ctx: OrchCtx): McpServer => {
  const server = new McpServer({ name: "scyne-workspace", version: "0.1.0" });

  server.registerTool(
    "start_stage",
    {
      title: "Start a pipeline stage",
      description:
        "Start one Scyne pipeline stage. It becomes a tracked issue, exactly as if it had " +
        "been started from the chatbot — visible in the console, Spend and Actions. " +
        "Returns immediately with an issue id; poll issue_status. Call `stages` for the " +
        "workflow keys this server offers — they are read from it live, so a stage the " +
        "pipeline gained since this plugin was installed still runs.",
      // A free string, NOT an enum. An enum would bake this server's stage list
      // into the plugin at registration time, which is the exact coupling
      // `stages.ts` exists to remove: a key is validated against GET /config
      // when the call is made, and an unknown one is refused with the list the
      // server actually has.
      inputSchema: {
        workflow: z.string().min(1),
        project: z.string().min(1),
        feature: z.string().optional(),
      },
    },
    async (args) => jsonResult(await startStage(ctx, args as any)),
  );

  server.registerTool(
    "stages",
    {
      title: "What can I run",
      description:
        "Every pipeline stage this server offers, with its level (project or feature) and " +
        "whether it is a revision variant. Read live from the orchestrator, never from a " +
        "list shipped in this plugin — so it cannot fall behind the server.",
      inputSchema: {},
    },
    async () => jsonResult(await stages(ctx)),
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

  // ---- documents -------------------------------------------------------

  server.registerTool(
    "ingest_document",
    {
      title: "Ingest a large document",
      description:
        "THE ONE FOR BIG FILES, and the one to prefer in general. Streams a local file to " +
        "Azure in 8 MiB blocks, has a worker convert it to markdown there, and files ONLY " +
        "the markdown into the project — so a multi-gigabyte PDF lands in the pipeline " +
        "without its contents ever entering the conversation. Accepts PDF, Word, " +
        "PowerPoint, Excel, HTML, CSV, RTF, EPUB and plain text. Blocks until the worker " +
        "finishes (minutes for a large file), then returns counts and a path — never text. " +
        "`kind` names the folder for a feature document (sop · transcripts · notes · ui). " +
        "The original stays archived in Azure; delete_job disposes of it.",
      inputSchema: {
        project: z.string().min(1),
        feature: z.string().optional(),
        path: z.string().min(1),
        kind: z.enum(["sop", "transcripts", "notes", "ui"]).optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async (args) => jsonResult(await ingestDocument(ctx, args as any)),
  );

  server.registerTool(
    "extract_status",
    {
      title: "Are the documents ready",
      description:
        "Whether a project's documents have finished extracting. Extraction starts BY ITSELF " +
        "the moment a document is uploaded — there is no step to run — so this answers " +
        "'is it ready yet?', not 'has it been started?'. `capabilities` refuses with " +
        "documents_not_ready until every document is done; that usually means wait, not " +
        "re-run. Re-run extract only for a document that arrived outside the upload routes, " +
        "or one that failed.",
      inputSchema: { project: z.string().min(1) },
    },
    async (args) => jsonResult(await extractStatus(ctx, args as any)),
  );

  server.registerTool(
    "read_document",
    {
      title: "Read a short document",
      description:
        "The full text of ONE document. For short notes only — anything substantial should " +
        "go through the file plane (upload_file, then search_chunks) so it does not fill the " +
        "context window. Refuses a binary file and any path outside documents/.",
      inputSchema: {
        project: z.string().min(1),
        feature: z.string().optional(),
        path: z.string().min(1),
      },
    },
    async (args) => jsonResult(await readDocument(ctx, args as any)),
  );

  server.registerTool(
    "replace_document",
    {
      title: "Replace a document",
      description:
        "Swap one document for a new local file. The old markdown AND its archived original " +
        "are removed first, so the replacement keeps its own name rather than landing beside " +
        "it as `handling (1).md`. `path` is the stored path from list_documents.",
      inputSchema: {
        project: z.string().min(1),
        feature: z.string().optional(),
        path: z.string().min(1),
        file: z.string().min(1),
      },
    },
    async (args) => jsonResult(await replaceDocument(ctx, args as any)),
  );

  server.registerTool(
    "delete_document",
    {
      title: "Delete a document",
      description:
        "Remove one document, its archived original, and its database row. ASK THE PERSON " +
        "FIRST — a sentence typed at a prompt is not consent to change what every later " +
        "stage reads. Taking the archived original too is what stops the next conversion " +
        "pass putting the document straight back. `path` is the stored path from " +
        "list_documents.",
      inputSchema: {
        project: z.string().min(1),
        feature: z.string().optional(),
        path: z.string().min(1),
      },
    },
    async (args) => jsonResult(await deleteDocument(ctx, args as any)),
  );

  // ---- pipeline --------------------------------------------------------

  server.registerTool(
    "revise_artefact",
    {
      title: "Revise an artefact",
      description:
        "Change something a stage already produced — 'add an SLA breach field to the data " +
        "model', 'reword story 2.4.1.3', 'the personas are too generic'. Hands the owning " +
        "agent its own previous output plus your instruction VERBATIM and asks for a SMALL " +
        "DIFF, not a regeneration. Raises its own approval gate; on approval it UPDATES the " +
        `existing wiki page rather than creating a second one. Artefacts: ${ARTEFACTS.join(", ")}.`,
      inputSchema: {
        project: z.string().min(1),
        feature: z.string().optional(),
        artefact: z.enum(ARTEFACTS as unknown as [string, ...string[]]),
        instruction: z.string().min(1),
      },
    },
    async (args) => jsonResult(await reviseArtefact(ctx, args as any)),
  );

  server.registerTool(
    "republish_artefact",
    {
      title: "Republish an artefact",
      description:
        "Publish an already-approved artefact again, to the SAME wiki page recorded in " +
        ".published.json. For when a publish failed on a bad target and the document itself " +
        "is fine — re-running the stage would cost another agent run to produce a document " +
        "that already exists.",
      inputSchema: {
        project: z.string().min(1),
        feature: z.string().optional(),
        artefact: z.enum(ARTEFACTS as unknown as [string, ...string[]]),
      },
    },
    async (args) => jsonResult(await republishArtefact(ctx, args as any)),
  );

  server.registerTool(
    "staleness",
    {
      title: "What is out of date",
      description:
        "Artefacts generated BEFORE one of their inputs last changed, by file mtime against " +
        "the pipeline graph. Nothing regenerates on its own — report what is stale and let " +
        "the person decide, because a refresh is twenty-five minutes and real money. " +
        "Over-reports rather than under-reports, deliberately.",
      inputSchema: { project: z.string().min(1), feature: z.string().optional() },
    },
    async (args) => jsonResult(await staleness(ctx, args as any)),
  );

  // ---- workspace -------------------------------------------------------

  server.registerTool(
    "get_project_definition",
    {
      title: "Read the project definition",
      description:
        "Who the client is, what they are regulated to do, who their customers are. EVERY " +
        "skill reads this before any discovery document, so a project without one produces " +
        "documents written in nobody's terms.",
      inputSchema: { project: z.string().min(1) },
    },
    async (args) => jsonResult(await getProjectDefinition(ctx, args as any)),
  );

  server.registerTool(
    "save_project_definition",
    {
      title: "Save the project definition",
      description:
        "Write the project definition from the user's own words. Minimum 40 characters — a " +
        "one-line description is worse than none, because it reads as authoritative and says " +
        "nothing. Ask once; never block a run waiting for it.",
      inputSchema: { project: z.string().min(1), description: z.string().min(1) },
    },
    async (args) => jsonResult(await saveProjectDefinition(ctx, args as any)),
  );

  server.registerTool(
    "extract_brand",
    {
      title: "Brand from a website",
      description:
        "Pull palette, wordmark and logo from the client's own site into the project's " +
        "theme.json, and re-render the companion app if one exists. Branding is per PROJECT " +
        "— one project renders one app, so it carries one palette. When a colour comes out " +
        "wrong, correct theme.json by hand; re-running on the same URL gives the same answer.",
      inputSchema: { project: z.string().min(1), url: z.string().min(1) },
    },
    async (args) => jsonResult(await extractBrand(ctx, args as any)),
  );

  // ---- issues and reporting --------------------------------------------

  server.registerTool(
    "cancel_issue",
    {
      title: "Cancel an issue",
      description:
        "End an issue for good. NOT pause: a cancelled issue does not resume and is never " +
        "retried, the agent in flight is killed, and any pending gate is cancelled with it " +
        "so abandoned work does not sit in an approval queue. Use pause_issue if the work " +
        "should carry on later.",
      inputSchema: { issueId: z.string().min(1) },
    },
    async (args) => jsonResult(await cancelIssue(ctx, args as any)),
  );

  server.registerTool(
    "request_changes",
    {
      title: "Request changes on a gate",
      description:
        "Reviewer feedback on a pending gate: comments it onto the issue and re-fires the " +
        "agent to regenerate. Between approve_gate (publishes) and reject_gate (rewinds " +
        "without a conversation) — this is the one that leaves a record of WHY.",
      inputSchema: { approvalId: z.string().min(1), feedback: z.string().min(1) },
    },
    async (args) => jsonResult(await requestChanges(ctx, args as any)),
  );

  server.registerTool(
    "issue_runs",
    {
      title: "Runs for an issue",
      description:
        "Every agent run against one issue: agent, phase, duration, tokens and cost. Two " +
        "rows a second apart mean an automatic retry, not two mysterious runs.",
      inputSchema: { issueId: z.string().min(1) },
    },
    async (args) => jsonResult(await issueRuns(ctx, args as any)),
  );

  server.registerTool(
    "run_transcript",
    {
      title: "Read a run transcript",
      description:
        "What one agent run actually did — tool calls, skill invocations, assistant text, " +
        "secrets scrubbed. Returns the TAIL, capped, because a twenty-five-minute run " +
        "produces megabytes of events and returning them whole is the context flooding this " +
        "plugin exists to prevent. Raise maxChars (max 32000) if the tail is not enough.",
      inputSchema: {
        runId: z.string().min(1),
        maxChars: z.number().int().positive().optional(),
      },
    },
    async (args) => jsonResult(await runTranscript(ctx, args as any)),
  );

  server.registerTool(
    "actions",
    {
      title: "Audit feed",
      description:
        "Who started, approved, paused or cancelled what, across the organisation. " +
        "Admin-only upstream; a refusal is reported as a refusal, never as an empty list.",
      inputSchema: {},
    },
    async () => jsonResult(await actions(ctx)),
  );

  server.registerTool(
    "history",
    {
      title: "Completed runs",
      description:
        "Every completed run with its wiki page and work item links — what was produced and " +
        "where it was published.",
      inputSchema: {},
    },
    async () => jsonResult(await history(ctx)),
  );

  // The `/scyne` slash command. Codex sources commands from MCP prompts,
  // not from a commands/ directory — see prompts.ts.
  registerPrompts(server);

  return server;
};
