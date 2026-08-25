import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../shared/config.js";
import type { Storage } from "../shared/storage.js";
import { createUploadUrl } from "./tools/create-upload-url.js";
import { startJob } from "./tools/start-job.js";
import { jobStatus } from "./tools/job-status.js";
import { getResult } from "./tools/get-result.js";
import { fetchChunks } from "./tools/fetch-chunks.js";
import { searchChunks } from "./tools/search-chunks.js";
import { deleteJob } from "./tools/delete-job.js";

export interface Ctx { cfg: Config; storage: Storage }

/** The shape every tool handler returns. Every later task registering a tool
 *  shapes its handler's return against this type. The index signature matches
 *  the MCP SDK's own `CallToolResult`, which allows arbitrary extra keys. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  [key: string]: unknown;
}

/** Every tool answers with compact JSON as text. Nothing returns a stream and
 *  nothing returns an artifact body — spec §10. */
export const jsonResult = (value: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export const buildMcpServer = (ctx: Ctx): McpServer => {
  const server = new McpServer({ name: "azure-files", version: "0.1.0" });

  server.registerTool(
    "create_upload_url",
    {
      title: "Create upload URL",
      description:
        "Mint a short-lived, write-only URL for one blob. Upload the file to it " +
        "directly with scripts/upload.mjs — never read the file into the conversation. " +
        "Pass sha256 (compute it first with `shasum -a 256 <file>` in the shell, never " +
        "by reading the file) to have the download verified once processing starts.",
      inputSchema: {
        filename: z.string().min(1),
        sizeBytes: z.number().int().positive(),
        contentType: z.string().optional(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      },
    },
    async (args) => jsonResult(await createUploadUrl(ctx, args)),
  );

  server.registerTool(
    "start_job",
    {
      title: "Start job",
      description: "Queue processing for an already-uploaded file. Returns immediately; poll job_status.",
      inputSchema: {
        jobId: z.string(),
        pipeline: z.object({
          id: z.string().default("extract-chunks"),
          params: z.record(z.string(), z.number()).optional(),
        }).optional(),
      },
    },
    async (args) => jsonResult(await startJob(ctx, args as any)),
  );

  server.registerTool(
    "job_status",
    {
      title: "Job status",
      description: "Poll a job's state and progress. States: awaiting_upload, queued, running, succeeded, failed, deleted.",
      inputSchema: { jobId: z.string() },
    },
    async (args) => jsonResult(await jobStatus(ctx, args)),
  );

  server.registerTool(
    "get_result",
    {
      title: "Get result",
      description:
        "Computed facts about a finished document plus its artifact paths — never bulk passage text. " +
        "Includes up to 50 short section headings as a bounded exception; use search_chunks and " +
        "fetch_chunks to read passages.",
      inputSchema: { jobId: z.string() },
    },
    async (args) => jsonResult(await getResult(ctx, args)),
  );

  server.registerTool(
    "fetch_chunks",
    {
      title: "Fetch chunks",
      description:
        "Read the full text of specific chunks, by id, from search_chunks results. " +
        "Capped at 32 KB per call; ask for the few chunks you need, never a whole document.",
      inputSchema: { jobId: z.string(), chunkIds: z.array(z.string()).min(1).max(10) },
    },
    async (args) => jsonResult(await fetchChunks(ctx, args)),
  );

  server.registerTool(
    "search_chunks",
    {
      title: "Search chunks",
      description:
        "Find the passages of a processed document that mention your terms. Returns short snippets " +
        "with page citations and chunk ids; pass those ids to fetch_chunks to read them in full.",
      inputSchema: {
        jobId: z.string(),
        query: z.string().min(1),
        topK: z.number().int().min(1).max(20).optional(),
      },
    },
    async (args) => jsonResult(await searchChunks(ctx, args)),
  );

  server.registerTool(
    "delete_job",
    {
      title: "Delete job",
      description: "Permanently remove a job's uploaded file and all of its artifacts.",
      inputSchema: { jobId: z.string() },
    },
    async (args) => jsonResult(await deleteJob(ctx, args)),
  );

  return server;
};
