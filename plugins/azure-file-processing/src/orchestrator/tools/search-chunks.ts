import { createInterface } from "node:readline";
import { getJob } from "../../shared/jobs.js";
import { artifactStream } from "../artifacts.js";
import type { Ctx } from "../mcp.js";
import { userError } from "../../shared/errors.js";

const MAX_TOPK = 20;
const SNIPPET_MAX = 300;
const SNIPPET_PAD = 120;

interface Hit { chunkId: string; pageStart: number; pageEnd: number; snippet: string; score: number }

const snippetAround = (text: string, at: number, termLength: number): string => {
  const start = Math.max(0, at - SNIPPET_PAD);
  const end = Math.min(text.length, at + termLength + SNIPPET_PAD);
  const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
  return raw.length > SNIPPET_MAX ? raw.slice(0, SNIPPET_MAX - 1) + "…" : raw;
};

/** `JSON.parse` returns `any`, so a record that parses successfully but has
 *  the wrong SHAPE (missing/null/non-string `text`, a missing id or page) is
 *  not caught by a type annotation — only a runtime check catches it. Treated
 *  exactly like a line that fails to parse at all: skip it, one line lost,
 *  never the whole search. */
const isWellShapedChunk = (v: unknown): v is { chunkId: string; pageStart: number; pageEnd: number; text: string } =>
  typeof v === "object" && v !== null &&
  typeof (v as any).chunkId === "string" &&
  typeof (v as any).pageStart === "number" &&
  typeof (v as any).pageEnd === "number" &&
  typeof (v as any).text === "string";

export const searchChunks = async (
  ctx: Ctx, args: { jobId: string; query: string; topK?: number },
) => {
  const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw userError("empty_query", "query must contain at least one term");
  const rawTopK = args.topK ?? 5;
  // Math.min/Math.max silently propagate a NaN or non-integer topK straight
  // through — `hits.length > NaN` is always false, so the trim below would
  // never run and the "only topK hits are ever held" bound this function
  // exists to guarantee would quietly stop holding. Reject it here, before
  // any scanning starts, rather than let it through and clamp is asked to do
  // work it cannot do on a value this malformed.
  if (!Number.isInteger(rawTopK)) throw userError("bad_topk", `topK must be an integer, got ${args.topK}`);
  const topK = Math.min(Math.max(1, rawTopK), MAX_TOPK);

  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw userError("unknown_job", `unknown job ${args.jobId}`);
  if (job.state !== "succeeded") throw userError("job_not_ready", `job ${args.jobId} is not ready: state is ${job.state}`);

  const stream = await artifactStream(ctx.storage, args.jobId, "chunks.jsonl");
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  // Only `topK` hits are ever held, so memory is bounded no matter how large
  // the chunk file is. Scanning to the ceiling rather than stopping at the
  // first K matches is what keeps ranking honest.
  const hits: Hit[] = [];
  let scannedBytes = 0, scannedChunks = 0, truncated = false;

  // The whole loop is wrapped so the underlying HTTP body is ALWAYS released —
  // on the ceiling break, on natural exhaustion, or on anything the loop body
  // throws that isn't caught locally. Without this, an exception partway
  // through (a malformed record the shape guard above doesn't yet anticipate,
  // or any other surprise) would skip `lines.close()`/`stream.destroy()`
  // entirely and leak the connection — a real cost, one search at a time, in a
  // long-lived server.
  try {
    for await (const line of lines) {
      scannedBytes += Buffer.byteLength(line, "utf8") + 1;
      if (!line.trim()) continue;
      scannedChunks++;

      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!isWellShapedChunk(parsed)) continue;
      const chunk = parsed;

      const haystack = chunk.text.toLowerCase();
      let score = 0, firstAt = -1, firstLen = 0;
      for (const term of terms) {
        let from = 0, at = haystack.indexOf(term, from);
        while (at !== -1) {
          score++;
          if (firstAt === -1 || at < firstAt) { firstAt = at; firstLen = term.length; }
          from = at + term.length;
          at = haystack.indexOf(term, from);
        }
      }

      if (score > 0) {
        hits.push({
          chunkId: chunk.chunkId, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, score,
          snippet: snippetAround(chunk.text, firstAt, firstLen),
        });
        hits.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
        if (hits.length > topK) hits.length = topK;
      }

      if (scannedBytes >= ctx.cfg.searchMaxScanBytes) { truncated = true; break; }
    }
  } finally {
    // Best-effort: cleanup must never itself throw and mask whatever error (if
    // any) is already propagating out of the try block above.
    try { lines.close(); } catch { /* already closing/closed */ }
    try { stream.destroy(); } catch { /* already destroyed */ }
  }

  return { jobId: args.jobId, hits, scannedBytes, scannedChunks, truncated };
};
