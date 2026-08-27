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

/** LocalStack's well-known development credentials. Not secrets; LocalStack
 *  accepts any non-empty pair and every machine running it uses the same
 *  placeholder, exactly as Azurite published one account key for everybody. */
const LOCALSTACK_ENDPOINT = "http://127.0.0.1:4566";
const LOCALSTACK_ACCESS_KEY_ID = "test";
const LOCALSTACK_SECRET_ACCESS_KEY = "test";
const LOCALSTACK_REGION = "us-east-1";

export interface Config {
  // ---- AWS ------------------------------------------------------------
  region: string;
  /** Where the SDK sends every S3/SQS/DynamoDB call. Null means "real AWS" —
   *  the SDK resolves the public regional endpoint itself. Set it to reach
   *  LocalStack, MinIO or any other emulator. */
  endpoint: string | null;
  /** Explicit static credentials. Null on BOTH means "let the default provider
   *  chain decide" — environment, shared config file, SSO, EC2/ECS/EKS role.
   *  That chain is the whole reason a production deployment needs no secret in
   *  this config at all, which is the AWS equivalent of the Managed Identity
   *  the Azure build was always heading for. */
  accessKeyId: string | null;
  secretAccessKey: string | null;
  sessionToken: string | null;
  /** Required by LocalStack and MinIO, wrong against real AWS. Defaults to
   *  true whenever a custom endpoint is set, because an emulator that is
   *  addressed virtual-host style (`bucket.localhost:4566`) resolves nowhere. */
  forcePathStyle: boolean;

  uploadsBucket: string;
  artifactsBucket: string;
  workspaceBucket: string;
  jobQueueName: string;
  poisonQueueName: string;
  jobsTable: string;

  orchPort: number;
  bearerToken: string | null;
  presignTtlSeconds: number;
  maxUploadBytes: number;
  fetchMaxBytes: number;
  searchMaxScanBytes: number;
  chunkChars: number;
  overlapChars: number;
  pageWindow: number;
  maxDequeueCount: number;
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
   *  natively beside Claude Code on one machine, and exactly wrong when it is
   *  reachable from anywhere else. Defaults OFF the moment MCP_BEARER_TOKEN is
   *  set, since a token is the only reason to set one: the endpoint is exposed.
   *  A remote server resolving a local path is not a lesser feature, it is a
   *  nonsense that reads whatever happens to sit at that path on the SERVER. */
  allowLocalPathUpload: boolean;
  /**
   * The S3 endpoint a PRESIGNED URL must be signed AGAINST.
   *
   * This is not the cosmetic string-swap its Azure ancestor was. SigV4 signs
   * the Host header, so a presigned URL minted against `http://localstack:4566`
   * (what the orchestrator can reach inside Compose) and then rewritten to
   * `http://127.0.0.1:4566` (what curl on the HOST can reach) fails signature
   * verification — the URL is not merely pointing at the wrong place, it is
   * cryptographically invalid. So a SECOND S3 client is built against this
   * endpoint and used for nothing but presigning, and the signature covers the
   * host the caller will actually use. Null means "presign against `endpoint`",
   * which is right when running natively.
   */
  publicS3Endpoint: string | null;

  // ---- MCP server 2 (scyne-workspace) ----------------------------------
  //
  // Distinct from everything above, which is server 1's (`scyne`, :8080)
  // AWS/job-processing config. This block is what lets server 2 reach the
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

/**
 * Whether to run against an emulator, and where.
 *
 * `AWS_ENDPOINT_URL` is the SDK's own standard variable (every v3 client reads
 * it), so honouring it here means `AWS_ENDPOINT_URL=http://localhost:4566` does
 * the same thing for this plugin as for the `aws` CLI sitting next to it. The
 * LocalStack default only applies when NOTHING says otherwise — neither an
 * endpoint nor a region nor a credential — because that combination can only
 * mean a developer machine with no AWS configuration at all. The moment a real
 * region or credential is present, this stops guessing: silently pointing a
 * configured account at 127.0.0.1 is how an upload disappears into a container
 * nobody is looking at.
 */
const resolveEndpoint = (env: NodeJS.ProcessEnv): string | null => {
  const explicit = env.AWS_ENDPOINT_URL_S3 || env.AWS_ENDPOINT_URL || env.S3_ENDPOINT;
  if (explicit) return explicit.replace(/\/+$/, "");
  const configured =
    env.AWS_REGION || env.AWS_DEFAULT_REGION ||
    env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE ||
    env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_WEB_IDENTITY_TOKEN_FILE;
  return configured ? null : LOCALSTACK_ENDPOINT;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const endpoint = resolveEndpoint(env);
  const emulated = endpoint !== null;
  return {
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || LOCALSTACK_REGION,
    endpoint,
    // An emulator needs a credential pair present and does not care what it is;
    // real AWS needs the provider chain, which a hard-coded "test" would shadow.
    accessKeyId: env.AWS_ACCESS_KEY_ID || (emulated ? LOCALSTACK_ACCESS_KEY_ID : null),
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY || (emulated ? LOCALSTACK_SECRET_ACCESS_KEY : null),
    sessionToken: env.AWS_SESSION_TOKEN || null,
    forcePathStyle: bool(env, "S3_FORCE_PATH_STYLE", emulated),

    uploadsBucket: env.S3_UPLOADS_BUCKET || "scyne-uploads",
    artifactsBucket: env.S3_ARTIFACTS_BUCKET || "scyne-artifacts",
    workspaceBucket: env.S3_WORKSPACE_BUCKET || "scyne-workspace",
    jobQueueName: env.SQS_JOB_QUEUE || "scyne-job-queue",
    poisonQueueName: env.SQS_POISON_QUEUE || "scyne-job-queue-poison",
    jobsTable: env.DYNAMODB_JOBS_TABLE || "scyne-jobs",

    orchPort: num(env, "ORCH_PORT", 8080),
    bearerToken: env.MCP_BEARER_TOKEN || null,
    presignTtlSeconds: num(env, "PRESIGN_TTL_SECONDS", 900),
    maxUploadBytes: num(env, "MAX_UPLOAD_BYTES", 5_368_709_120),
    fetchMaxBytes: num(env, "FETCH_MAX_BYTES", 32_768),
    searchMaxScanBytes: num(env, "SEARCH_MAX_SCAN_BYTES", 134_217_728),
    chunkChars: num(env, "DEFAULT_CHUNK_CHARS", 4_000),
    overlapChars: num(env, "DEFAULT_OVERLAP_CHARS", 200),
    pageWindow: num(env, "DEFAULT_PAGE_WINDOW", 25),
    maxDequeueCount: num(env, "MAX_DEQUEUE_COUNT", 3),
    tempDir: env.TEMP_DIR || "/tmp/afp",
    markdownMaxBytes: num(env, "MARKDOWN_MAX_BYTES", defaultMarkdownMaxBytes()),
    allowLocalPathUpload: bool(env, "ALLOW_LOCAL_PATH_UPLOAD", !env.MCP_BEARER_TOKEN),
    publicS3Endpoint: env.S3_PUBLIC_ENDPOINT || null,

    orchUrl: env.SCYNE_ORCH_URL || "http://127.0.0.1:3100",
    orchToken: env.SCYNE_ORCH_TOKEN || null,
    chatbotUrl: env.SCYNE_CHATBOT_URL || `http://127.0.0.1:${env.CHATBOT_PORT || 4000}`,
    workspacePort: num(env, "WORKSPACE_PORT", 8081),
    workspaceRoot: env.WORKSPACE_PATH || WORKSPACE_ROOT || process.cwd(),
  };
};

/**
 * The logical names the rest of the code addresses storage by.
 *
 * On Azure these were a container name, a queue name and a table name — fixed
 * strings, because an Azure storage ACCOUNT is the tenancy boundary and two
 * installations never shared one. An S3 bucket name is GLOBAL across every AWS
 * account on earth, so the real name has to be configurable and these become
 * KEYS into the config rather than the names themselves. `bucketFor` is the one
 * place that mapping happens, so a caller still writes
 * `bucketFor(cfg, UPLOADS)` and never a bare string.
 */
export const UPLOADS = "uploads" as const;
export const ARTIFACTS = "artifacts" as const;
export const WORKSPACE = "workspace" as const;
export type BucketKey = typeof UPLOADS | typeof ARTIFACTS | typeof WORKSPACE;

export const bucketFor = (cfg: Config, key: BucketKey): string =>
  key === UPLOADS ? cfg.uploadsBucket
  : key === ARTIFACTS ? cfg.artifactsBucket
  : cfg.workspaceBucket;

export const JOB_QUEUE = "job-queue" as const;
export const POISON_QUEUE = "job-queue-poison" as const;
export type QueueKey = typeof JOB_QUEUE | typeof POISON_QUEUE;

export const queueNameFor = (cfg: Config, key: QueueKey): string =>
  key === JOB_QUEUE ? cfg.jobQueueName : cfg.poisonQueueName;
