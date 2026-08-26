import { getJob } from "../../shared/jobs.js";
import { readArtifactJson, readArtifactRange } from "../artifacts.js";
import type { ChunkIndexEntry } from "../../worker/artifacts.js";
import type { Ctx } from "../mcp.js";
import { userError } from "../../shared/errors.js";

const MAX_IDS = 10;

export const fetchChunks = async (
  ctx: Ctx, args: { jobId: string; chunkIds: string[] },
) => {
  if (args.chunkIds.length > MAX_IDS) {
    throw userError("too_many_chunks", `at most ${MAX_IDS} chunk ids per call, got ${args.chunkIds.length}`);
  }
  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw userError("unknown_job", `unknown job ${args.jobId}`);
  if (job.state !== "succeeded") throw userError("job_not_ready", `job ${args.jobId} is not ready: state is ${job.state}`);

  const index = await readArtifactJson<Record<string, ChunkIndexEntry>>(
    ctx.storage, args.jobId, "index.json");

  const chunks: Array<{ chunkId: string; pageStart: number; pageEnd: number; text: string }> = [];
  let bytes = 0;
  let truncated = false;

  for (const chunkId of args.chunkIds) {
    const entry = index[chunkId];
    if (!entry) throw userError("unknown_chunk", `unknown chunk ${chunkId} in job ${args.jobId}`);
    if (bytes + entry.byteLength > ctx.cfg.fetchMaxBytes) { truncated = true; break; }

    // Only these bytes leave storage — the chunk file itself is never read.
    const line = await readArtifactRange(
      ctx.storage, args.jobId, "chunks.jsonl", entry.byteOffset, entry.byteLength);
    const parsed = JSON.parse(line) as
      { chunkId: string; pageStart: number; pageEnd: number; text: string };
    chunks.push({
      chunkId: parsed.chunkId, pageStart: parsed.pageStart,
      pageEnd: parsed.pageEnd, text: parsed.text,
    });
    bytes += entry.byteLength;
  }

  return {
    jobId: args.jobId, chunks, bytes, truncated,
    requested: args.chunkIds.length, returned: chunks.length,
  };
};
