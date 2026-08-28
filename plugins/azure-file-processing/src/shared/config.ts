import { readFileSync, existsSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the WORKSPACE ROOT's `.env` into `process.env`, once, at import.
 *
 * The plugin never did this, and two real failures came out of it: every
 * workspace tool answered 401 because `SCYNE_ORCH_TOKEN` was unset when a test
 * ran from the plugin directory, and `workspaceRoot` fell back to `cwd` —
 * the plugin subdirectory — which masked what a dual-write test was actually
 * doing and left three stray Azure DevOps projects on a client's tenant.
 *
 * Dependency-free by necessity: the plugin declares no `dotenv`, and the root
 * has no runtime dependencies at all. The root is found the same way
 * `scyne-chatbot/server/env.ts` finds it — by walking up for the two
 * directories that only the workspace root has — so it is cwd-independent.
 *
 * An existing environment variable always wins: an explicit export, or a value
 * Compose injected, must not be silently overwritten by a file on disk.
 */
const findWorkspaceRoot = (): string | null => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "agent-instructions")) && existsSync(join(dir, "skills"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return null;
};

const loadDotEnv = (): string | null => {
  const root = findWorkspaceRoot();
  if (!root) return null;
  const file = join(root, ".env");
  if (!existsSync(file)) return root;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return root;
};

const WORKSPACE_ROOT = loadDotEnv();

/** Azurite's well-known development account. Not a secret; it is published by
 *  Microsoft and is identical on every machine running Azurite. */
const AZURITE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;" +
  "QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;" +
  "TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;";

export interface Config {
  connectionString: string;
  orchPort: number;
  bearerToken: string | null;
  sasTtlSeconds: number;
  maxUploadBytes: number;
  fetchMaxBytes: number;
  searchMaxScanBytes: number;
  chunkChars: number;
  overlapChars: number;
  pageWindow: number;
  maxDequeueCount: number;
  /** Ceiling on ONE structured-converter call. See markdown.ts. */
  convertTimeoutMs: number;
  tempDir: string;
  /** Above this, `document.md` is produced by the STREAMING extractor instead
   *  of markitdown — flat text, but one page of memory rather than the whole
   *  document. It is the worker's HEAP being protected here, not the model's
   *  context: the ceiling exists so one enormous upload cannot take a worker
   *  down and strand every job queued behind it.
   *
   *  DERIVED from the heap limit rather than fixed, because a fixed number is
   *  only ever right for one heap size. Measured: a 40,000-page PDF (~130 MB)
   *  under the acceptance suite's deliberately capped `--max-old-space-size=256`
   *  worker sat below a fixed 256 MiB ceiling, so markitdown buffered it and
   *  the run died — breaking the bounded-memory guarantee that suite exists to
   *  prove. A twelfth of the heap leaves room for the source buffer, the
   *  parser's intermediate strings and the markdown output all being live at
   *  once, which is roughly three to four times the file's size in practice. */
  markdownMaxBytes: number;
  /** Whether `upload_file` is offered at all — the one tool that reads a path
   *  from the caller's own filesystem. True means the orchestrator process can
   *  open any document its user can, which is exactly the point when it runs
   *  natively beside Codex on one machine, and exactly wrong when it is
   *  reachable from anywhere else. Defaults OFF the moment MCP_BEARER_TOKEN is
   *  set, since a token is the only reason to set one: the endpoint is exposed.
   *  A remote server resolving a local path is not a lesser feature, it is a
   *  nonsense that reads whatever happens to sit at that path on the SERVER. */
  allowLocalPathUpload: boolean;
  /** The blob endpoint a MINTED SAS URL must carry. Inside Compose the
   *  orchestrator reaches Azurite at http://azurite:10000, but the SAS is used
   *  by curl on the HOST, where that name does not resolve. Null means "use the
   *  endpoint from the connection string", which is right when running natively. */
  publicBlobEndpoint: string | null;

  // ---- MCP server 2 (scyne-workspace) ----------------------------------
  //
  // Distinct from everything above, which is server 1's (`scyne`, :8080)
  // Azurite/job-processing config. This block is what lets server 2 reach the
  // Scyne orchestrator and chatbot that already run natively on this machine.

  /** Where MCP server 2 reaches the Scyne orchestrator. */
  orchUrl: string;
  /** Bearer token for it. auth-middleware accepts
   *  `bearerFrom(headers) ?? cookieCredential(headers)`, and this server is not
   *  a browser, so a token is the only option it has. Also sent to the chatbot
   *  — both accept the same token. */
  orchToken: string | null;
  /** Where MCP server 2 reaches the Scyne chatbot for document uploads. */
  chatbotUrl: string;
  /** Port for MCP server 2. 8080 belongs to the file plane. */
  workspacePort: number;
  /** The Scyne workspace root — where `projects/<project>/...` lives on disk.
   *  Defaults to cwd because this server is meant to run from the repo root. */
  workspaceRoot: string;
}

/** Accepts the shapes an operator actually types. Anything else is a typo
 *  worth refusing loudly rather than silently reading as false — a security
 *  gate that mis-parses to "off" wastes an afternoon, and one that mis-parses
 *  to "on" is worse. */
const bool = (env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${key} must be true or false, got ${raw}`);
};

const num = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${raw}`);
  return n;
};

/** A twelfth of this process's heap, capped at 256 MiB so a machine with a
 *  large default heap does not decide to buffer a gigabyte-scale document just
 *  because it could. Floored at 4 MiB so a very small heap still converts
 *  ordinary notes properly rather than sending everything down the flat-text
 *  path. `MARKDOWN_MAX_BYTES` overrides it outright. */
const defaultMarkdownMaxBytes = (): number => {
  const heap = getHeapStatistics().heap_size_limit;
  return Math.max(4 * 1024 * 1024, Math.min(268_435_456, Math.floor(heap / 12)));
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => ({
  connectionString: env.AZURE_STORAGE_CONNECTION_STRING || AZURITE_CONNECTION_STRING,
  orchPort: num(env, "ORCH_PORT", 8080),
  bearerToken: env.MCP_BEARER_TOKEN || null,
  sasTtlSeconds: num(env, "SAS_TTL_SECONDS", 900),
  maxUploadBytes: num(env, "MAX_UPLOAD_BYTES", 5_368_709_120),
  fetchMaxBytes: num(env, "FETCH_MAX_BYTES", 32_768),
  searchMaxScanBytes: num(env, "SEARCH_MAX_SCAN_BYTES", 134_217_728),
  chunkChars: num(env, "DEFAULT_CHUNK_CHARS", 4_000),
  overlapChars: num(env, "DEFAULT_OVERLAP_CHARS", 200),
  pageWindow: num(env, "DEFAULT_PAGE_WINDOW", 25),
  maxDequeueCount: num(env, "MAX_DEQUEUE_COUNT", 3),
  // Long enough for a 200 MB .docx on a busy worker, short enough that a
  // wedged engine costs one document's conversion quality rather than the
  // whole job. The fallback is the streaming extractor, which always
  // finishes — so the cost of hitting this is flat text, not a failure.
  convertTimeoutMs: num(env, "CONVERT_TIMEOUT_MS", 120_000),
  tempDir: env.SCYNE_AZURE_TEMP_DIR || env.TEMP_DIR || "/tmp/scyne-azure-files",
  markdownMaxBytes: num(env, "MARKDOWN_MAX_BYTES", defaultMarkdownMaxBytes()),
  allowLocalPathUpload: bool(env, "ALLOW_LOCAL_PATH_UPLOAD", !env.MCP_BEARER_TOKEN),
  publicBlobEndpoint: env.SAS_PUBLIC_BLOB_ENDPOINT || null,

  orchUrl: env.SCYNE_ORCH_URL || "http://127.0.0.1:3100",
  orchToken: env.SCYNE_ORCH_TOKEN || null,
  chatbotUrl: env.SCYNE_CHATBOT_URL || `http://127.0.0.1:${env.CHATBOT_PORT || 4000}`,
  workspacePort: num(env, "WORKSPACE_PORT", 8081),
  workspaceRoot: env.WORKSPACE_PATH || WORKSPACE_ROOT || process.cwd(),
});

export const UPLOADS_CONTAINER = "uploads";
export const ARTIFACTS_CONTAINER = "artifacts";
export const JOB_QUEUE = "job-queue";
export const POISON_QUEUE = "job-queue-poison";
export const JOBS_TABLE = "jobs";
