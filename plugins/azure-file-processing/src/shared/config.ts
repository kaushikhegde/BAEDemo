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
  tempDir: string;
  /** The blob endpoint a MINTED SAS URL must carry. Inside Compose the
   *  orchestrator reaches Azurite at http://azurite:10000, but the SAS is used
   *  by curl on the HOST, where that name does not resolve. Null means "use the
   *  endpoint from the connection string", which is right when running natively. */
  publicBlobEndpoint: string | null;
}

const num = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${raw}`);
  return n;
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
  tempDir: env.TEMP_DIR || "/tmp/afp",
  publicBlobEndpoint: env.SAS_PUBLIC_BLOB_ENDPOINT || null,
});

export const UPLOADS_CONTAINER = "uploads";
export const ARTIFACTS_CONTAINER = "artifacts";
export const JOB_QUEUE = "job-queue";
export const POISON_QUEUE = "job-queue-poison";
export const JOBS_TABLE = "jobs";
