// The document store: content addressed by hash, named and versioned by path.
//
// Two tables, not one. `blobs` holds bytes keyed by their own SHA-256;
// `documents` holds the naming, versioning and provenance that points at them.
// The split is what makes the two operations this store exists for cheap:
//
//   uploading the same 4 MB .docx to three features stores one copy, and
//   harvesting a run that rewrote one file of forty creates one new version
//   and thirty-nine no-ops.
//
// That second property is not an optimisation, it is the harvest contract.
// `put()` returns `changed: false` when the bytes at a path are identical to
// the current version, so a caller can diff a whole materialised tree by
// writing every file back and believing the answer.
//
// Behind an interface because the backend is a decision that may be revisited:
// bytes in Postgres is simple, transactional with its own metadata, and backs
// up as one thing — but a companion app is 3 MB and a wireframe PNG is not
// small. Swapping in an object-store backend must not touch a single caller.

import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import type { BlobBackend } from "./blobs.js";
import { newId } from "./ids.js";

export interface DocumentRef {
  id: string;
  projectId: string;
  /** null means the document belongs to the project itself, not to one feature. */
  featureId: string | null;
  /** Relative to the document's own level — the same convention `produces[]` uses. */
  path: string;
  category: string | null;
  stage: string | null;
  sha256: string;
  version: number;
  bytes: number;
  contentType: string | null;
  createdAt: string;
}

export interface PutInput {
  projectId: string;
  featureId?: string | null;
  path: string;
  content: Buffer | string;
  category?: string | null;
  stage?: string | null;
  contentType?: string | null;
  uploadedBy?: string | null;
}

export interface ListFilter {
  featureId?: string | null;
  /** Omit to list the project's own documents AND every feature's. */
  anyLevel?: boolean;
  category?: string;
  stage?: string;
  /** Prefix match on `path`, e.g. "requirements/SOP/". */
  prefix?: string;
}

export interface DocumentStore {
  /** Write a version of `path`. A no-op returning `changed: false` when the bytes already match. */
  put(input: PutInput): Promise<{ doc: DocumentRef; changed: boolean }>;
  /** The current version at a path, with its bytes. */
  get(projectId: string, featureId: string | null, path: string):
    Promise<{ ref: DocumentRef; content: Buffer } | null>;
  /** Bytes for one specific document row, current or superseded. */
  read(documentId: string): Promise<Buffer | null>;
  /** Current documents, newest first. */
  list(projectId: string, filter?: ListFilter): Promise<DocumentRef[]>;
  /** Every version of one path, newest first. */
  history(projectId: string, featureId: string | null, path: string): Promise<DocumentRef[]>;
  /** Mark the current version deleted. Bytes are never removed — other paths may share them. */
  remove(projectId: string, featureId: string | null, path: string): Promise<boolean>;
}

export function sha256Of(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface DocRow {
  id: string; project_id: string; feature_id: string | null; path: string;
  category: string | null; stage: string | null; sha256: string; version: number;
  bytes: string | number; content_type: string | null; created_at: string;
}

const toRef = (r: DocRow): DocumentRef => ({
  id: r.id, projectId: r.project_id, featureId: r.feature_id, path: r.path,
  category: r.category, stage: r.stage, sha256: r.sha256, version: Number(r.version),
  bytes: Number(r.bytes), contentType: r.content_type, createdAt: r.created_at,
});

/**
 * `feature_id is null` cannot be written as `feature_id = $n` — in SQL, null
 * equals nothing, including itself. Every lookup in this file needs the same
 * two-shape predicate, so it is built once.
 */
function levelPredicate(featureId: string | null, params: unknown[]): string {
  if (featureId === null) return `feature_id is null`;
  params.push(featureId);
  return `feature_id = $${params.length}`;
}

const SELECT = `d.id, d.project_id, d.feature_id, d.path, d.category, d.stage,
                d.sha256, d.version, d.is_current, d.created_at,
                b.bytes, b.content_type`;

/**
 * `blobs` is REQUIRED. There is no default any more — the Postgres one was the
 * default until 011 dropped the column it wrote to, and a silent fallback to
 * anything else would mean an install storing documents somewhere nobody chose.
 */
export function createDocumentStore(db: Db, blobs: BlobBackend): DocumentStore {
  return {
    async put(input) {
      const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content;
      const sha = sha256Of(content);
      const featureId = input.featureId ?? null;

      // Is this path already at these exact bytes? If so there is nothing to
      // record: a new version identical to the current one is noise in the
      // history and a false positive in every "what changed" question.
      const params: unknown[] = [input.projectId];
      const pred = levelPredicate(featureId, params);
      params.push(input.path);
      const current = await db.query<DocRow>(
        `select ${SELECT} from documents d join blobs b on b.sha256 = d.sha256
          where d.project_id = $1 and d.${pred} and d.path = $${params.length} and d.is_current`,
        params);

      if (current.rows[0]?.sha256 === sha) {
        return { doc: toRef(current.rows[0]), changed: false };
      }

      // Content first, then the row that names it.
      //
      // The BACKEND stores bytes and returns a locator; it does not touch the
      // database. `blobs` is metadata ABOUT content it no longer holds — the
      // hash that names it, its size, its type, and where it actually is — and
      // writing that row here is what keeps a backend from needing to know
      // there is a database at all.
      //
      // Idempotent: two features uploading the same file concurrently are
      // writing the same bytes under the same hash, and must not race each
      // other into a duplicate-key failure. `documents.sha256` is a foreign key
      // onto this row, so it has to exist before the document row does.
      const locator = await blobs.write(sha, content, input.contentType ?? null);
      await db.query(
        `insert into blobs (sha256, bytes, content_type, blob_path) values ($1,$2,$3,$4)
         on conflict (sha256) do nothing`,
        [sha, content.length, input.contentType ?? null, locator]);

      // Supersede before inserting: the partial unique index permits exactly
      // one current row per path, so this ordering is load-bearing.
      if (current.rows[0]) {
        await db.query(`update documents set is_current = false where id = $1`, [current.rows[0].id]);
      }

      // Counted from the PATH's history, not from the current row. After a
      // `remove()` there is no current row, so counting from it restarted at 1
      // — leaving two version-1 rows on one path and making `history()`, which
      // orders by version, ambiguous about which came first. Unreachable until
      // remove() was given an HTTP route; a delete-then-reupload is the most
      // ordinary thing a person does with a document they got wrong.
      const maxParams: unknown[] = [input.projectId];
      const maxPred = levelPredicate(featureId, maxParams);
      maxParams.push(input.path);
      const highest = await db.query<{ v: string | number }>(
        `select coalesce(max(version), 0) as v from documents
          where project_id = $1 and ${maxPred} and path = $${maxParams.length}`,
        maxParams);

      const id = newId();
      const version = Number(highest.rows[0]?.v ?? 0) + 1;
      await db.query(
        `insert into documents
           (id, project_id, feature_id, path, category, stage, sha256, version, is_current, uploaded_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)`,
        [id, input.projectId, featureId, input.path,
         input.category ?? current.rows[0]?.category ?? null,
         input.stage ?? null, sha, version, input.uploadedBy ?? null]);

      const { rows } = await db.query<DocRow>(
        `select ${SELECT} from documents d join blobs b on b.sha256 = d.sha256 where d.id = $1`, [id]);
      return { doc: toRef(rows[0]), changed: true };
    },

    async get(projectId, featureId, path) {
      const params: unknown[] = [projectId];
      const pred = levelPredicate(featureId, params);
      params.push(path);
      const { rows } = await db.query<DocRow & { blob_path: string | null }>(
        `select ${SELECT}, b.blob_path from documents d join blobs b on b.sha256 = d.sha256
          where d.project_id = $1 and d.${pred} and d.path = $${params.length} and d.is_current`,
        params);
      if (!rows[0]) return null;
      const content = rows[0].blob_path ? await blobs.read(rows[0].blob_path) : null;
      // A row whose bytes are not where its locator says is a real state — a
      // store restored without its container — and is reported as absent
      // rather than as an empty document.
      if (content === null) return null;
      return { ref: toRef(rows[0]), content };
    },

    async read(documentId) {
      const { rows } = await db.query<{ blob_path: string | null }>(
        `select b.blob_path from documents d join blobs b on b.sha256 = d.sha256 where d.id = $1`,
        [documentId]);
      if (!rows[0]?.blob_path) return null;
      return blobs.read(rows[0].blob_path);
    },

    async list(projectId, filter = {}) {
      const params: unknown[] = [projectId];
      const where = [`d.project_id = $1`, `d.is_current`];

      // Three distinct questions, not two: "the project's own documents"
      // (feature_id is null), "this feature's" (feature_id = x), and "all of
      // them" (anyLevel). Collapsing the first and third is the bug that makes
      // a project-level stage read a feature's files.
      if (!filter.anyLevel) where.push(levelPredicate(filter.featureId ?? null, params));
      if (filter.category) { params.push(filter.category); where.push(`d.category = $${params.length}`); }
      if (filter.stage) { params.push(filter.stage); where.push(`d.stage = $${params.length}`); }
      if (filter.prefix) { params.push(filter.prefix + "%"); where.push(`d.path like $${params.length}`); }

      const { rows } = await db.query<DocRow>(
        `select ${SELECT} from documents d join blobs b on b.sha256 = d.sha256
          where ${where.join(" and ")} order by d.created_at desc, d.path`, params);
      return rows.map(toRef);
    },

    async history(projectId, featureId, path) {
      const params: unknown[] = [projectId];
      const pred = levelPredicate(featureId, params);
      params.push(path);
      const { rows } = await db.query<DocRow>(
        `select ${SELECT} from documents d join blobs b on b.sha256 = d.sha256
          where d.project_id = $1 and d.${pred} and d.path = $${params.length}
          order by d.version desc`, params);
      return rows.map(toRef);
    },

    async remove(projectId, featureId, path) {
      const params: unknown[] = [projectId];
      const pred = levelPredicate(featureId, params);
      params.push(path);
      // The row is retired, not deleted, and the blob is never touched: other
      // paths and older versions may reference the same content, and a store
      // that deleted shared bytes would corrupt them silently.
      const { rows } = await db.query<{ id: string }>(
        `update documents set is_current = false
          where project_id = $1 and ${pred} and path = $${params.length} and is_current
          returning id`, params);
      return rows.length > 0;
    },
  };
}
