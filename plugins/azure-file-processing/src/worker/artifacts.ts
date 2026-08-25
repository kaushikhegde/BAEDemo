import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { once } from "node:events";
import { ARTIFACTS_CONTAINER, type Config } from "../shared/config.js";
import type { Storage } from "../shared/storage.js";
import { log } from "../shared/logger.js";
import { chunkPages, type PageText } from "./chunk.js";
import { writeMarkdownFile, type Converter } from "./markdown.js";
import type { DocMetadata } from "./extract/index.js";

export interface ChunkIndexEntry {
  byteOffset: number; byteLength: number; pageStart: number; pageEnd: number;
}

export interface JobResult {
  pages: number; words: number; chunks: number;
  language: string; headings: string[]; tables: number; durationMs: number;
  /** Which engine produced `document.md`, and how long it is. Absent when
   *  no `source` was supplied and therefore no markdown was rendered. */
  converter?: Converter; markdownChars?: number;
}

const HEADING = /^(?:#{1,6}\s+\S|\d+(?:\.\d+)*[.)]?\s+[A-Z])/;
const MAX_HEADINGS = 50;
const EN_STOPWORDS = new Set(["the", "of", "and", "to", "in", "is", "that", "for", "it", "as"]);

export const writeArtifacts = async (
  s: Storage, cfg: Config, jobId: string,
  input: {
    pages: AsyncIterable<PageText>;
    meta: DocMetadata;
    chunkChars: number;
    overlapChars: number;
    onProgress?: (pagesDone: number) => void;
    /** The downloaded file itself, so `document.md` can be rendered from it.
     *  Optional: a caller that only wants chunks (every unit test here) omits
     *  it and no markdown artifact is written. */
    source?: {
      path: string; ext: string; filename: string;
      converterOverride?: Converter | null;
    };
  },
): Promise<JobResult> => {
  const startedAt = Date.now();
  await mkdir(cfg.tempDir, { recursive: true });
  const scratch = join(cfg.tempDir, `${randomUUID()}-chunks.jsonl`);
  const mdScratch = join(cfg.tempDir, `${randomUUID()}-document.md`);
  // Declared here, not inside the try block, so the finally below can destroy
  // it: createWriteStream's open() is asynchronous, and abandoning the stream
  // without destroying it lets a deferred open() (still holding buffered
  // writes issued before we threw) recreate the scratch file MOMENTS AFTER
  // the finally block below has removed it — a genuine race, not a hypothetical
  // one, caught by the "leaves no scratch file" test further down.
  let out: ReturnType<typeof createWriteStream> | undefined;

  // Everything below can throw partway through — chunkPages, the write stream,
  // or an upload — and the scratch file (potentially gigabytes) must never
  // survive that. force:true tolerates it not existing yet (a failure before
  // the stream ever opened); the cleanup's own failure is swallowed so it can
  // never mask the real error that got us here.
  try {
    const index: Record<string, ChunkIndexEntry> = {};
    const headings: string[] = [];
    let byteOffset = 0, words = 0, chunks = 0, tables = 0, stopwordHits = 0, pagesSeen = 0;

    // Facts are gathered on the way past, so nothing is buffered beyond the one
    // page the extractor just produced.
    const counted = async function* (): AsyncGenerator<PageText> {
      for await (const p of input.pages) {
        pagesSeen = Math.max(pagesSeen, p.page);
        for (const line of p.text.split("\n")) {
          const t = line.trim();
          if (t && headings.length < MAX_HEADINGS && t.length < 80 && HEADING.test(t)) headings.push(t);
          // "tables" is a heuristic: a line with three or more columnar gaps,
          // which pdftotext -layout preserves. Nothing short of rendering the
          // page identifies a table properly, and this is a computed fact, not a
          // claim about the document.
          if ((line.match(/ {2,}/g) ?? []).length >= 3) tables++;
        }
        for (const w of p.text.split(/\s+/)) {
          if (!w) continue;
          words++;
          if (EN_STOPWORDS.has(w.toLowerCase())) stopwordHits++;
        }
        // Progress reporting must never be able to break the extraction it is
        // reporting on — a throwing callback is logged and swallowed, never
        // propagated.
        try {
          input.onProgress?.(pagesSeen);
        } catch (err) {
          log.warn("artifacts.progress_callback_failed", {
            jobId, message: String((err as Error)?.message ?? err).slice(0, 200),
          });
        }
        yield p;
      }
    };

    // Assigned to the outer `out` too, so the finally block below can destroy
    // it; `stream` is used through the rest of this try block purely so
    // TypeScript can narrow it as always-defined here (it cannot narrow a
    // variable captured by the Promise executor's closure below).
    const stream = createWriteStream(scratch);
    out = stream;
    // A listener attached for the stream's whole lifetime, not only while a
    // drain/finish wait happens to be pending. events.once() only special-cases
    // 'error' during an active wait, and most out.write() calls return true and
    // never enter one — so an async write failure (ENOSPC on a multi-gigabyte
    // scratch file is a realistic trigger) emitted between writes would
    // otherwise have no listener at all, and Node treats an unhandled 'error'
    // event as an uncaught exception that kills the whole worker process, not
    // just this job. `streamDone` settles whenever the stream does, no matter
    // when that happens relative to this function's control flow, so awaiting
    // it at the end can never hang on a 'finish' an already-errored stream will
    // never emit.
    let streamError: Error | null = null;
    const streamDone = new Promise<void>((resolve, reject) => {
      stream.once("finish", resolve);
      stream.once("error", (err) => { streamError = err as Error; reject(err); });
    });
    // Observed for real via `await streamDone` below on the success path; this
    // extra handler only silences Node's unhandled-rejection warning on the
    // paths where we instead throw the captured `streamError` directly (e.g.
    // from inside the loop) without ever reaching that await.
    streamDone.catch(() => {});

    for await (const chunk of chunkPages(counted(), {
      chunkChars: input.chunkChars, overlapChars: input.overlapChars,
    })) {
      if (streamError) throw streamError;
      const line = JSON.stringify(chunk) + "\n";
      // Byte length, not string length. The index is consumed as a BYTE range by
      // fetch_chunks, and the two diverge the moment a document is not ASCII —
      // which would silently corrupt every citation.
      const byteLength = Buffer.byteLength(line, "utf8");
      index[chunk.chunkId] = {
        byteOffset, byteLength, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd,
      };
      byteOffset += byteLength;
      chunks++;
      if (!stream.write(line)) await once(stream, "drain");
    }
    if (streamError) throw streamError;
    stream.end();
    await streamDone;

    const container = s.blob.getContainerClient(ARTIFACTS_CONTAINER);
    const put = (name: string, body: string) =>
      container.getBlockBlobClient(`${jobId}/${name}`)
        .upload(body, Buffer.byteLength(body), {
          blobHTTPHeaders: { blobContentType: "application/json" },
        });

    // `document.md` is rendered SEPARATELY from the chunks above, deliberately,
    // rather than by chunking the markdown. The two artifacts answer two
    // different questions and want opposite things: chunks want page numbers,
    // because every citation search_chunks returns is a page reference, and
    // markitdown throws pagination away (it is a rendering decision, absent
    // from a .docx entirely). The markdown wants headings and tables, which the
    // page-at-a-time extractor cannot see. Producing each with the engine that
    // suits it costs one extra pass over a file that is already on local disk,
    // and keeps both properties instead of trading one away for the other.
    let markdown: { converter: Converter; chars: number } | null = null;
    if (input.source) {
      markdown = await writeMarkdownFile(
        mdScratch, input.source.path, input.source.ext, input.source.filename, cfg,
        input.source.converterOverride ?? null,
      );
    }

    const result: JobResult = {
      pages: Math.max(input.meta.pages, pagesSeen),
      words, chunks,
      language: words > 0 && stopwordHits / words > 0.02 ? "en" : "unknown",
      headings, tables,
      durationMs: Date.now() - startedAt,
      ...(markdown ? { converter: markdown.converter, markdownChars: markdown.chars } : {}),
    };

    // uploadFile streams from disk, so chunks.jsonl is never held in memory —
    // building it as a string would reintroduce the whole-file load this design
    // exists to avoid.
    //
    // Upload order below is deliberate, and is the whole failure-recovery
    // strategy for a crash between these four calls: result.json is the
    // completion marker, uploaded LAST, only once chunks.jsonl, index.json and
    // metadata.json have all succeeded. get_result refuses any job whose
    // recorded state is not "succeeded", so a partial artifact set — some of
    // the four blobs present, result.json absent — is never read as complete.
    // The worker loop leaves a failed job's queue message for another attempt
    // rather than deleting it, and every upload here is idempotent by path
    // (same jobId/name), so a retry simply overwrites whatever partial set was
    // left behind. No rollback is attempted here, deliberately: rollback
    // machinery can itself fail halfway, trading one partial state for another.
    if (markdown) {
      await container.getBlockBlobClient(`${jobId}/document.md`).uploadFile(mdScratch, {
        blobHTTPHeaders: { blobContentType: "text/markdown; charset=utf-8" },
      });
    }
    await container.getBlockBlobClient(`${jobId}/chunks.jsonl`).uploadFile(scratch, {
      blobHTTPHeaders: { blobContentType: "application/x-ndjson" },
    });
    await put("index.json", JSON.stringify(index));
    await put("metadata.json", JSON.stringify(input.meta));
    await put("result.json", JSON.stringify(result));

    return result;
  } finally {
    // destroyed is false on the success path too (stream.end() drives it to
    // "finished", not "destroyed") and false when we are unwinding because
    // chunkPages/the pages generator threw with the write side otherwise
    // healthy — in both cases destroy() is what stops a still-pending open()
    // from later flushing its buffered writes: without it, that deferred
    // open() can complete AFTER rm() below has already run, recreating the
    // very file this cleanup exists to remove. Waiting for 'close' ensures
    // that deferred open()/flush has fully settled one way or the other
    // before rm() runs, so there is nothing left racing it.
    //
    // destroyed is already true when the STREAM ITSELF errored: Node's
    // autoDestroy has already destroyed it and emitted 'close' by the time
    // this finally block runs, and 'close' fires at most once per stream — so
    // calling destroy() again and awaiting a second 'close' here would hang
    // forever waiting for an event that has already happened.
    if (out && !out.destroyed) {
      out.destroy();
      await once(out, "close").catch(() => {});
    }
    await rm(scratch, { force: true }).catch(() => {});
    await rm(mdScratch, { force: true }).catch(() => {});
  }
};
