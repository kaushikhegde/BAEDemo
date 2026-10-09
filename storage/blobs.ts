import { resolve } from "node:path";
import type { BlobBackend } from "../packages/orchestrator/src/index.js";
import { localBlobBackend } from "./local-blobs.js";

/**
 * Which object store the orchestrator keeps document bytes in.
 *
 * Two stacks share this one installation and its one Postgres:
 *
 *   Claude  -> AWS S3        + Jira / Confluence
 *   Codex   -> Azure Blob    + Azure DevOps
 *
 * and a third store needs neither: a LOCAL folder, for a machine with no
 * Docker and no cloud account. `SCYNE_DOCUMENT_STORE` (local | s3 | azure)
 * is the one switch between them; unset, it is S3 or Azure when one is
 * configured and the local folder otherwise.
 *
 * So this is NOT an either/or. Both may be configured at once — both plugins
 * are meant to be usable at the same time — and when they are, the composite
 * below reads from whichever store actually holds a given blob.
 *
 * That works because a locator names its owner: `s3:<bucket>/<name>` and
 * `azure:<container>/<name>`. Each backend already refuses a locator carrying
 * the other's prefix and answers `null`, so dispatch is just "ask each until
 * one answers" — no registry, and no way for a stale locator to be read out of
 * the wrong store.
 *
 * The SDKs are loaded with DYNAMIC imports, which is the point rather than a
 * detail. A Claude install must pull in nothing from `@azure/storage-blob`,
 * and a Codex install nothing from the AWS SDK. A static import at the top of
 * this file would defeat that however carefully the branch below was written.
 */

export type BlobEnv = Record<string, string | undefined>;

type Store = "local" | "s3" | "azure";
const STORES: Store[] = ["local", "s3", "azure"];

const objectStores = (env: BlobEnv): Store[] => [
  ...(env.SCYNE_S3_DOCUMENTS_BUCKET ? ["s3" as const] : []),
  ...(env.AZURE_STORAGE_CONNECTION_STRING ? ["azure" as const] : []),
];

/**
 * Where new bytes go. Reads span every store, so flipping this never strands a
 * document written under the other setting.
 *
 * `SCYNE_BLOB_WRITE` is the older name for the same switch and still honoured.
 * Unset: S3 when configured — the store this repo's default plugin drives —
 * then Azure, then the local folder. A named store that is not configured is
 * refused at boot rather than quietly swapped for another one.
 */
const writeTarget = (env: BlobEnv): Store => {
  const named = (env.SCYNE_DOCUMENT_STORE ?? env.SCYNE_BLOB_WRITE)?.trim().toLowerCase();
  const have = objectStores(env);
  if (!named) return have[0] ?? "local";
  if (!STORES.includes(named as Store)) {
    throw new Error(`SCYNE_DOCUMENT_STORE must be local, s3 or azure — got ${JSON.stringify(named)}`);
  }
  if (named !== "local" && !have.includes(named as Store)) {
    throw new Error(named === "s3"
      ? "SCYNE_DOCUMENT_STORE=s3 but SCYNE_S3_DOCUMENTS_BUCKET is not set"
      : "SCYNE_DOCUMENT_STORE=azure but AZURE_STORAGE_CONNECTION_STRING is not set");
  }
  return named as Store;
};

/** The local store's folder. Relative paths are taken from the install root. */
export const localBlobDir = (env: BlobEnv = process.env): string =>
  resolve(env.SCYNE_INSTALL_ROOT ?? process.cwd(), env.SCYNE_BLOB_DIR ?? ".orchestrator/blobs");

export const describeBlobConfig = (env: BlobEnv = process.env): string => {
  const target = writeTarget(env);
  // The local folder is always readable, but only worth naming once it is in
  // use — an S3 install should read "s3" at boot, not a list.
  const stores = target === "local" ? ["local", ...objectStores(env)] : objectStores(env);
  if (stores.length === 1) return stores[0];
  return `${stores.join(" + ")}, writing to ${target} (set SCYNE_DOCUMENT_STORE to change)`;
};

/**
 * Reads span every configured store; writes go to one.
 *
 * `read` returns the first non-null answer. Order does not matter for
 * correctness — a locator can only match one backend's prefix — so this is a
 * dispatch, not a search with a precedence rule to get wrong.
 */
export const compositeBlobBackend = (
  write: BlobBackend, all: BlobBackend[],
): BlobBackend => ({
  write: (sha256, content, contentType) => write.write(sha256, content, contentType),
  async read(locator) {
    for (const b of all) {
      const got = await b.read(locator);
      if (got) return got;
    }
    return null;
  },
});


const explicitCredentials = (env: BlobEnv) =>
  env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      }
    : null;

/**
 * LocalStack's well-known development credentials, used ONLY when the endpoint
 * is a loopback address and nothing else supplied a pair.
 *
 * Not a secret: LocalStack accepts any non-empty pair and every machine running
 * it uses the same placeholder — the same reasoning the plugin's own config
 * already applies, and mirroring it here is what makes "point the orchestrator
 * at LocalStack" work without putting fake credentials in the shared `.env`.
 *
 * Deliberately narrow. Against real AWS this returns null, so the default
 * provider chain still decides and an instance role is never overridden by a
 * placeholder that would fail with a confusing signature error.
 */
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal|localstack)(:|\/|$)/i;

const emulatorCredentials = (env: BlobEnv) => {
  const endpoint = env.SCYNE_S3_ENDPOINT ?? env.AWS_ENDPOINT_URL;
  if (!endpoint || !LOOPBACK.test(endpoint)) return null;
  return { accessKeyId: "test", secretAccessKey: "test" };
};

export const selectBlobBackend = async (
  env: BlobEnv = process.env,
): Promise<BlobBackend> => {
  const target = writeTarget(env);
  const bucket = env.SCYNE_S3_DOCUMENTS_BUCKET;
  const conn = env.AZURE_STORAGE_CONNECTION_STRING;

  // Always present as a reader, whatever takes writes: it costs nothing until a
  // `local:` locator is asked for, and it is what lets an install switch to S3
  // and back without losing the documents written in between.
  const local = localBlobBackend({ dir: localBlobDir(env) });

  const s3 = bucket
    ? (await import("./s3-blobs.js")).s3BlobBackend({
        bucket,
        region: env.SCYNE_S3_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
        // A custom endpoint is how LocalStack is reached. Absent means real AWS.
        endpoint: env.SCYNE_S3_ENDPOINT ?? env.AWS_ENDPOINT_URL ?? null,
        forcePathStyle: env.SCYNE_S3_FORCE_PATH_STYLE
          ? env.SCYNE_S3_FORCE_PATH_STYLE !== "false"
          : undefined,
        // Left null on purpose in the ordinary case: the SDK's default provider
        // chain covers environment, profile, SSO and instance roles, and
        // hard-coding a pair here would override a role that was working.
        // The one exception is an emulator — see `emulatorCredentials`.
        credentials: explicitCredentials(env) ?? emulatorCredentials(env),
      })
    : null;

  const azure = conn
    ? (await import("./azure-blobs.js")).azureBlobBackend({
        connectionString: conn,
        container: env.AZURE_DOCUMENTS_CONTAINER ?? "documents",
      })
    : null;

  const primary = { local, s3, azure }[target]!;
  const all = [local, s3, azure].filter((b): b is BlobBackend => b !== null);
  return compositeBlobBackend(primary, all);
};
