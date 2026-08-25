import { getJob } from "../../shared/jobs.js";
import { readArtifactJson, artifactBytes } from "../artifacts.js";
import type { JobResult } from "../../worker/artifacts.js";
import type { Ctx } from "../mcp.js";

const MAX_RESPONSE_BYTES = 8192;

const ARTIFACTS = [
  // Listed but NEVER returned inline: it is the whole document. `bytes` is a
  // properties read, so naming it here costs nothing and tells a caller the
  // markdown exists to be ingested. ingest_document is what moves it.
  { type: "markdown", name: "document.md",   contentType: "text/markdown" },
  { type: "chunks",   name: "chunks.jsonl",  contentType: "application/x-ndjson" },
  { type: "index",    name: "index.json",    contentType: "application/json" },
  { type: "metadata", name: "metadata.json", contentType: "application/json" },
  { type: "result",   name: "result.json",   contentType: "application/json" },
] as const;

export const getResult = async (ctx: Ctx, args: { jobId: string }) => {
  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw new Error(`unknown job ${args.jobId}`);
  // `deleted` is terminal — unlike every other non-"succeeded" state, polling
  // again will never make it ready, so it earns its own message rather than
  // reading like the ordinary "still working" refusal below.
  if (job.state === "deleted") {
    throw new Error(`job ${args.jobId} has been deleted; its artifacts no longer exist`);
  }
  if (job.state !== "succeeded") {
    throw new Error(`job ${args.jobId} is not ready: state is ${job.state}`);
  }

  const result = await readArtifactJson<JobResult>(ctx.storage, args.jobId, "result.json");
  // §6.4 names `bytes` as part of the contract per artifact — a HEAD-style
  // properties read, never a download, so this stays cheap even for a
  // multi-hundred-megabyte chunks.jsonl.
  // §6.4 names `bytes` as part of the contract per artifact — a HEAD-style
  // properties read, never a download, so this stays cheap even for a
  // multi-hundred-megabyte chunks.jsonl.
  const artifacts = await Promise.all(ARTIFACTS.map(async (a) => ({
    type: a.type, blobPath: `${args.jobId}/${a.name}`, contentType: a.contentType,
    bytes: await artifactBytes(ctx.storage, args.jobId, a.name),
  })));

  // The cap is structural, not aspirational: a document with fifty long headings
  // would otherwise push the response past 8 KB, and "compact" would become a
  // claim rather than a property.
  //
  // The trim below is single-pass and not re-verified against
  // MAX_RESPONSE_BYTES afterwards. It is sufficient today only because it
  // relies on an implicit coupling with worker/artifacts.ts: MAX_HEADINGS
  // (50) and the 80-char-per-heading cap there bound how large `headings`
  // can ever be before it reaches here. If either of those grows, ten
  // headings may no longer be enough to land back under the cap, and this
  // trim would need to become iterative (or re-check its own output) rather
  // than assuming one cut is always sufficient.
  const payload = { jobId: args.jobId, result, artifacts };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_RESPONSE_BYTES) {
    payload.result = { ...result, headings: result.headings.slice(0, 10) };
  }
  return payload;
};
