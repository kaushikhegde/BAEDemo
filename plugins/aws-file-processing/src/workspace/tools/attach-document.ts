import { readFile, stat } from "node:fs/promises";
import { userError } from "../../shared/errors.js";
import { basename, isAbsolute, resolve } from "node:path";
import type { OrchCtx } from "../orchestrator.js";
import { putDocument } from "../doc-store.js";
import { convertToMarkdown } from "../doc-convert.js";
import { log } from "../../shared/logger.js";

/** The four discovery folders a feature document can land in. The pipeline
 *  reads the FOLDER, not the filename — the BA treats `Transcripts/` as the
 *  source of stories and `SOP/` as context that is explicitly not stories — so
 *  this choice changes what the document means, not just where it sits. */
export type DocKind = "sop" | "transcripts" | "notes" | "ui";

const KIND_FOLDER: Record<DocKind, string> = {
  sop: "SOP", transcripts: "Transcripts", notes: "Notes", ui: "UI",
};

export interface AttachArgs {
  project: string; feature?: string; path: string; kind?: DocKind;
}

export interface AttachResult {
  project: string;
  feature: string | null;
  filename: string;
  storedPath: string;
  subfolder: string | null;
  converted: boolean;
  converter: string;
  version: number | null;
  changed: boolean;
}

export interface PostArgs {
  project: string; feature?: string; kind?: DocKind;
  filename: string; bytes: Buffer;
  /** Set when the bytes are ALREADY markdown a converter produced — the worker
   *  path has done the conversion out in the pool and must not convert twice. */
  preConverted?: boolean;
}

/**
 * The path a document is stored at, relative to its OWN level — the convention
 * `produces[]` in `pipeline.mjs` uses, and what every stage globs for.
 *
 *   project document   ->  documents/<name>.md
 *   feature document   ->  requirements/<Folder>/<name>.md
 *
 * Built here rather than by the chatbot, which is what used to own it. That
 * move is the whole change: the chatbot decided the path because the chatbot
 * was doing the `fs.writeFile`, and nothing writes to disk any more.
 */
export const storedPathFor = (filename: string, feature?: string, kind?: DocKind): string =>
  feature
    ? `requirements/${KIND_FOLDER[kind ?? "notes"]}/${filename}`
    : `documents/${filename}`;

/**
 * Store one document: object storage plus its database row, written together
 * by the orchestrator.
 *
 * This used to POST multipart to the chatbot's `/api/upload`, which did an
 * `fs.writeFile` into `projects/<p>/…` and left the store untouched. Disk was
 * therefore the record, which is backwards — the bucket is the source of
 * truth, and a `projects/` tree only exists while a stage runs, pulled down at
 * the start of a step and deleted after it.
 *
 * Two failures came out of the old shape, and both are why this is the seam:
 * a document could land on disk with no row (exactly what a failed blob write
 * produced), and the write only worked where the plugin shared a filesystem
 * with the tree — which an end user never does.
 *
 * Both doors come through here — `attach_document` with bytes off the caller's
 * disk, `ingest_document` with markdown fetched back from the object store —
 * so the path convention and the conversion rule have one home rather than two.
 */
export const postDocument = async (ctx: OrchCtx, args: PostArgs): Promise<AttachResult> => {
  if (args.kind && !args.feature) {
    // Refused rather than ignored: a project document always lands in
    // `documents/`, so honouring a `kind` there would teach a caller that it
    // did something.
    throw userError("kind_not_applicable",
      "kind applies to a FEATURE document only; a project document always lands in documents/");
  }

  const converted = args.preConverted
    ? { filename: args.filename, content: args.bytes, converter: "worker", chars: args.bytes.length }
    : await convertToMarkdown(args.bytes, args.filename, ctx.cfg);

  const path = storedPathFor(converted.filename, args.feature, args.kind);
  const doc: any = await putDocument(ctx, {
    project: args.project,
    feature: args.feature ?? null,
    path,
    content: converted.content,
    category: args.kind ?? null,
  });

  log.info("workspace.document_stored", {
    project: args.project, feature: args.feature ?? "",
    // The NAME and the size, never the contents.
    path, bytes: converted.content.length, converter: converted.converter,
  });

  return {
    project: args.project,
    feature: args.feature ?? null,
    filename: converted.filename,
    storedPath: path,
    subfolder: args.feature ? KIND_FOLDER[args.kind ?? "notes"] : null,
    converted: !args.preConverted && converted.filename !== args.filename,
    converter: converted.converter,
    version: typeof doc?.version === "number" ? doc.version : null,
    // `changed: false` is a real answer, not a failure: identical content at
    // the same path is a no-op the store reports rather than a second version.
    changed: doc?.changed !== false,
  };
};

/**
 * Attach a document read from the CALLER's disk.
 *
 * Holds the whole file in memory, so it suits a note or a transcript and not a
 * multi-gigabyte PDF. `ingest_document` is the one for those: same
 * destination, but the bytes go straight to object storage and only the
 * markdown comes back.
 */
export const attachDocument = async (ctx: OrchCtx, args: AttachArgs): Promise<AttachResult> => {
  const abs = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);

  // Named refusal before the network call: "ENOENT" surfacing from inside an
  // upload is far harder to act on than the path that was not there.
  const st = await stat(abs).catch(() => null);
  // `args.path` rather than `abs`: the caller typed the first and can act on
  // it, while the second is a path on whichever machine serves this plane.
  if (!st || !st.isFile()) throw userError("no_such_file", `no such file: ${args.path}`);

  return await postDocument(ctx, {
    project: args.project, feature: args.feature, kind: args.kind,
    filename: basename(abs), bytes: await readFile(abs),
  });
};
