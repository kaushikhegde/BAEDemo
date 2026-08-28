import {
  S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand,
  HeadBucketCommand, CreateBucketCommand,
} from "@aws-sdk/client-s3";
import type { BlobBackend } from "../packages/orchestrator/src/index.js";
import { blobNameFor } from "./blob-name.js";

export interface S3BlobOptions {
  bucket: string;
  /** Defaults to us-east-1, which is also what LocalStack answers to. */
  region?: string;
  /** Null means real AWS — the SDK resolves the public regional endpoint
   *  itself. Set it to reach LocalStack, MinIO or any other emulator. */
  endpoint?: string | null;
  /** Required by LocalStack and MinIO, wrong against real AWS. Defaults to
   *  true whenever a custom endpoint is set, because an emulator addressed
   *  virtual-host style (`bucket.localhost:4566`) resolves nowhere. */
  forcePathStyle?: boolean;
  /** Null means "let the default provider chain decide" — environment, shared
   *  config file, SSO, EC2/ECS/EKS role. That chain is why a production
   *  deployment needs no secret in this config at all, and is the AWS
   *  equivalent of the Managed Identity the Azure backend leans on. */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null;
}

/**
 * Bytes in S3, addressed by their own SHA-256. The AWS half of the pair whose
 * other half is `azure-blobs.ts`, and deliberately the same shape: a Claude
 * install runs this one and never loads `@azure/storage-blob`; a Codex install
 * runs that one and never loads the AWS SDK.
 *
 * Lives here rather than in `packages/orchestrator/` for the same reason the
 * Azure backend does: that package declares exactly three dependencies and an
 * object-store client is not going to be the fourth. It is injected through
 * `config.blobs`, the way `adapters` already are.
 *
 * Never overwrites: the same hash is the same bytes, so a second write of a
 * blob that exists is a no-op rather than a conflict. That is what lets two
 * features uploading the same document store one copy.
 *
 * The locator is `s3:<bucket>/<name>`, matching `azure:<container>/<name>`.
 * Both backends refuse a locator carrying the other's prefix, which is what
 * makes `compositeBlobBackend` safe: a database holding documents written by
 * BOTH stacks reads correctly, because each locator says who owns it.
 */
export const s3BlobBackend = (opts: S3BlobOptions): BlobBackend => {
  const bucket = opts.bucket;
  const prefix = `s3:${bucket}/`;
  const client = new S3Client({
    region: opts.region ?? "us-east-1",
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  });

  // Once per process, like the Azure backend's `createIfNotExists`. A bucket
  // that already exists is the ordinary case, so this is a HEAD before a
  // CREATE rather than a create-and-swallow.
  let ensured: Promise<void> | null = null;
  const ensure = () => (ensured ??= (async () => {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (e: any) {
      if (!isNotFound(e)) throw e;
      try {
        // us-east-1 must NOT carry a LocationConstraint; every other region
        // must. Sending the wrong one is an InvalidLocationConstraint, which
        // reads as a credentials problem and is not.
        const region = opts.region ?? "us-east-1";
        await client.send(new CreateBucketCommand({
          Bucket: bucket,
          ...(region === "us-east-1" ? {}
            : { CreateBucketConfiguration: { LocationConstraint: region as any } }),
        }));
      } catch (ce: any) {
        // Two processes racing the same first write is normal, not an error.
        const code = ce?.name ?? ce?.Code;
        if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") throw ce;
      }
    }
  })());

  return {
    async write(sha256, content, contentType) {
      await ensure();
      const name = blobNameFor(sha256);
      const locator = `${prefix}${name}`;

      // Content-addressed, so an existing object already holds exactly these
      // bytes. Skipping the upload is not an optimisation — re-uploading would
      // burn the egress and time this whole design exists to avoid.
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: name }));
        return locator;
      } catch (e: any) {
        if (!isNotFound(e)) throw e;
      }

      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: name,
        Body: content,
        ...(contentType ? { ContentType: contentType } : {}),
      }));
      return locator;
    },

    async read(locator) {
      // A locator from another backend is not this backend's to answer for.
      if (!locator.startsWith(prefix)) return null;
      const name = locator.slice(prefix.length);
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: name }));
        if (!out.Body) return null;
        // transformToByteArray drains the stream the SDK gives back; reading it
        // by hand differs between Node and the browser build.
        return Buffer.from(await (out.Body as any).transformToByteArray());
      } catch (e: any) {
        // A missing object is a real state, not an error: a bucket restored
        // without its keys, or a locator recorded before a failed write.
        if (isNotFound(e)) return null;
        throw e;
      }
    },
  };
};

/** 404 arrives as three different shapes depending on the operation — HEAD
 *  gives a bare `NotFound` with no code, GET gives `NoSuchKey`, and a bucket
 *  probe gives `NoSuchBucket`. Checking only one of them is how a missing blob
 *  becomes a thrown error on some calls and null on others. */
const isNotFound = (e: any): boolean =>
  e?.$metadata?.httpStatusCode === 404 ||
  ["NotFound", "NoSuchKey", "NoSuchBucket"].includes(e?.name ?? e?.Code);
