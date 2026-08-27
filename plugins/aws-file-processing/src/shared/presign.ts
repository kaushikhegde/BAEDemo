import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "./config.js";
import type { Storage } from "./storage.js";

export interface MintedUrl { url: string; expiresAt: string }

/**
 * A presigned PUT scoped to exactly one object key.
 *
 * It cannot read, cannot list, and cannot address any other key — the key is
 * inside the signed canonical request, so altering the path invalidates the
 * signature. Its lifetime is `presignTtlSeconds` and it inherits the calling
 * identity's permissions, which is the one real difference from a service SAS:
 * a presigned URL can never grant more than the signer already has, so the
 * narrowing that mattered on Azure (`permissions: "cw"`) is done here by the
 * IAM policy attached to the orchestrator's role rather than by this call.
 *
 * Signed against `storage.presign`, NOT `storage.s3`. SigV4 covers the Host
 * header: a URL signed against the endpoint this process reaches (inside
 * Compose, `http://localstack:4566`) and handed to a caller who must use a
 * different one (`http://127.0.0.1:4566`) is not merely pointing at the wrong
 * host — it fails signature verification, and answers 403 with a signature that
 * looks perfectly well-formed. `publicS3Endpoint` is what builds that second
 * client; see shared/storage.ts.
 */
export const mintUploadUrl = async (
  s: Storage, cfg: Config, bucket: string, key: string, now: Date = new Date(),
): Promise<MintedUrl> => {
  const url = await getSignedUrl(
    s.presign,
    new PutObjectCommand({ Bucket: bucket, Key: key }),
    {
      expiresIn: cfg.presignTtlSeconds,
      // `now` is the signing instant, NOT merely a label for the expiry it
      // reports. SigV4 expiry is `X-Amz-Date + X-Amz-Expires`, both inside the
      // signature, so a `now` that did not reach the signer would produce a URL
      // that reported one lifetime and actually had another — and a test
      // asserting "an expired URL is refused" would silently be asserting
      // nothing, because it would still be minting a live one.
      signingDate: now,
    },
  );
  return {
    url,
    // Derived from the same instant that was signed, rather than read back off
    // the URL: the caller wants to know when it stops working, and X-Amz-Date
    // plus X-Amz-Expires is two fields it should not have to parse.
    expiresAt: new Date(now.getTime() + cfg.presignTtlSeconds * 1000).toISOString(),
  };
};
