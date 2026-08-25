import {
  BlobSASPermissions, SASProtocol, generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import type { Config } from "./config.js";
import type { Storage } from "./storage.js";

export interface MintedSas { url: string; expiresAt: string }

/** A SERVICE SAS scoped to exactly one blob, permissions create+write only.
 *  It cannot read, cannot list, and cannot address any other blob name — the
 *  blob name is inside the signed string, so altering the path invalidates it.
 *  In prod this becomes a user-delegation SAS via Managed Identity (spec §12);
 *  only this function changes. */
export const mintUploadSas = (
  s: Storage, cfg: Config, container: string, blobPath: string, now: Date = new Date(),
): MintedSas => {
  const expiresOn = new Date(now.getTime() + cfg.sasTtlSeconds * 1000);
  const qs = generateBlobSASQueryParameters(
    {
      containerName: container,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("cw"),
      startsOn: new Date(now.getTime() - 60_000), // tolerate clock skew
      expiresOn,
      protocol: SASProtocol.HttpsAndHttp,          // http, because Azurite is http
    },
    s.sharedKey,
  ).toString();

  const base = (cfg.publicBlobEndpoint ?? s.blob.url).replace(/\/+$/, "");
  // Percent-encode each URL path segment — never the RAW blobName signed
  // above, since Azure signs the decoded name and encoding it too would
  // invalidate every SAS. Unencoded, a filename containing '#' opens a URL
  // fragment (dropping everything after it, including the signature) and one
  // containing '?' opens a second, bogus query string — either mints a URL
  // that PUTs 403 even though the SAS itself is valid.
  const encodedPath = blobPath.split("/").map(encodeURIComponent).join("/");
  return {
    url: `${base}/${container}/${encodedPath}?${qs}`,
    expiresAt: expiresOn.toISOString(),
  };
};
