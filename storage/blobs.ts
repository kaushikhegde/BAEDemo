import type { BlobBackend } from "../packages/orchestrator/src/index.js";

/**
 * Which object store the orchestrator keeps document bytes in.
 *
 * Two stacks share this one installation and its one Postgres:
 *
 *   Claude  -> AWS S3        + Jira / Confluence
 *   Codex   -> Azure Blob    + Azure DevOps
 *
 * so this is NOT an either/or. Both may be configured at once — both plugins
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

/** Where new bytes go when BOTH stores are configured. Reads still span both. */
const writeTarget = (env: BlobEnv, hasS3: boolean, hasAzure: boolean): "s3" | "azure" => {
  const explicit = env.SCYNE_BLOB_WRITE?.trim().toLowerCase();
  if (explicit === "s3" || explicit === "azure") return explicit;
  // No explicit choice and both present: S3 wins, because the Claude stack is
  // the one this repo's default plugin drives. Announced in the log rather
  // than silent — a person who configured both and expected the other should
  // find out from a line at boot, not from a blob in the wrong bucket.
  return hasS3 ? "s3" : "azure";
};

export const describeBlobConfig = (env: BlobEnv = process.env): string => {
  const hasS3 = Boolean(env.SCYNE_S3_DOCUMENTS_BUCKET);
  const hasAzure = Boolean(env.AZURE_STORAGE_CONNECTION_STRING);
  if (!hasS3 && !hasAzure) return "none (documents have nowhere to live)";
  if (hasS3 && hasAzure) {
    return `s3 + azure, writing to ${writeTarget(env, true, true)} (set SCYNE_BLOB_WRITE to change)`;
  }
  return hasS3 ? "s3" : "azure";
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
): Promise<BlobBackend | undefined> => {
  const bucket = env.SCYNE_S3_DOCUMENTS_BUCKET;
  const conn = env.AZURE_STORAGE_CONNECTION_STRING;
  if (!bucket && !conn) return undefined;

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

  if (s3 && !azure) return s3;
  if (azure && !s3) return azure;

  const primary = writeTarget(env, true, true) === "s3" ? s3! : azure!;
  return compositeBlobBackend(primary, [s3!, azure!]);
};
