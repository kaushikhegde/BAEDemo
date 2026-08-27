import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, UPLOADS } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { mintUploadUrl } from "../src/shared/presign.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const bucket = storage.bucket(UPLOADS);
beforeAll(async () => { await ensureStorage(storage); });

const put = (url: string, body: string) => fetch(url, { method: "PUT", body });

/**
 * These assertions are only meaningful when the endpoint actually VERIFIES a
 * presigned URL's signature. LocalStack ships with `S3_SKIP_SIGNATURE_VALIDATION`
 * on by default for backwards compatibility, which turns every "must be
 * refused" case below into a silent pass — a green suite proving nothing about
 * the property it exists to protect. `docker-compose.yml` sets it to "0"; this
 * probe is what notices if that ever stops being true, rather than letting the
 * whole describe block quietly become decoration.
 */
const signatureValidationOn = async (): Promise<boolean> => {
  const { url } = await mintUploadUrl(storage, cfg, bucket, "presign-probe/x.txt");
  const tampered = url.replace("presign-probe/x.txt", "presign-probe/y.txt");
  return (await put(tampered, "nope")).status === 403;
};

describe("mintUploadUrl", () => {
  it("writes the object it is scoped to", async () => {
    const { url } = await mintUploadUrl(storage, cfg, bucket, "presign-test/ok.txt");
    expect((await put(url, "hello")).ok).toBe(true);
  });

  it("is signed against the presigning client, so it carries a real signature", async () => {
    const { url } = await mintUploadUrl(storage, cfg, bucket, "presign-test/signed.txt");
    // SigV4 puts the whole credential scope in the query string, which is what
    // makes the host part of the signature rather than an addressable detail.
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=");
  });

  it("reports an expiry in the future, matching the configured TTL", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { expiresAt } = await mintUploadUrl(storage, cfg, bucket, "presign-test/ttl.txt", now);
    expect(new Date(expiresAt).getTime())
      .toBe(now.getTime() + cfg.presignTtlSeconds * 1000);
  });

  it("cannot READ the object it just wrote", async () => {
    if (!(await signatureValidationOn())) {
      throw new Error(
        "the S3 endpoint is not verifying presigned signatures — set " +
        "S3_SKIP_SIGNATURE_VALIDATION=0 (docker-compose.yml does). Every " +
        "refusal asserted below is meaningless without it.");
    }
    // SigV4 signs the METHOD, so a PUT signature cannot serve a GET.
    const { url } = await mintUploadUrl(storage, cfg, bucket, "presign-test/noread.txt");
    await put(url, "hello");
    expect((await fetch(url)).status).toBe(403);
  });

  it("cannot write a DIFFERENT object key", async () => {
    // The key is inside the signed canonical request, so altering the path
    // invalidates the signature.
    const { url } = await mintUploadUrl(storage, cfg, bucket, "presign-test/scoped.txt");
    const other = url.replace("presign-test/scoped.txt", "presign-test/elsewhere.txt");
    expect((await put(other, "nope")).status).toBe(403);
  });

  it("cannot LIST the bucket", async () => {
    const { url } = await mintUploadUrl(storage, cfg, bucket, "presign-test/nolist.txt");
    const qs = url.split("?")[1];
    const base = url.split("?")[0].replace(/\/presign-test\/nolist\.txt$/, "");
    expect((await fetch(`${base}?list-type=2&${qs}`)).status).toBe(403);
  });

  it("is rejected once expired", async () => {
    // `past` reaches the SIGNER (see mintUploadUrl), so this is a genuinely
    // expired URL rather than a live one carrying a misleading `expiresAt`.
    const past = new Date(Date.now() - (cfg.presignTtlSeconds + 3600) * 1000);
    const { url } = await mintUploadUrl(storage, cfg, bucket, "presign-test/expired.txt", past);
    const res = await put(url, "nope");
    expect(res.ok).toBe(false);
    // Real S3 answers 403 AccessDenied ("Request has expired"); LocalStack
    // answers 400. The property is the refusal, not the digit.
    expect([400, 403]).toContain(res.status);
  });

  it("is rejected when its HOST is edited", async () => {
    // The failure this plugin's S3_PUBLIC_ENDPOINT exists to prevent, asserted
    // rather than asserted-about: SigV4 signs the Host header, so a URL that
    // has been pointed somewhere else is cryptographically invalid however
    // correct it looks. The Azure build could rewrite a SAS's host freely,
    // because a SAS signature covers no host at all.
    const { url } = await mintUploadUrl(storage, cfg, bucket, "presign-test/rehosted.txt");
    const moved = url.replace("127.0.0.1", "localhost");
    if (moved === url) return; // nothing to rewrite on this endpoint
    const res = await put(moved, "nope").catch(() => null);
    // Either refused outright, or unreachable — never a successful write.
    expect(res === null || res.ok === false).toBe(true);
  });
});

describe("mintUploadUrl — filenames needing URL-safe encoding", () => {
  // '#' opens a URL fragment and '?' opens a bogus query string, either of
  // which truncates or corrupts the signed query string appended after it. The
  // v3 presigner encodes the key into the canonical URI itself, so these are a
  // regression guard on that rather than on hand-rolled encoding — which is
  // precisely what the Azure build had to do, and get right, by itself.
  const cases: Array<[string, string]> = [
    ["'#'", "presign-test/notes#1.pdf"],
    ["'?'", "presign-test/invoice?v2.pdf"],
    ["unicode and a space", "presign-test/café report.pdf"],
    ["a plus sign", "presign-test/q1+q2.pdf"],
  ];
  for (const [what, key] of cases) {
    it(`uploads a filename containing ${what}`, async () => {
      const { url } = await mintUploadUrl(storage, cfg, bucket, key);
      expect((await put(url, "hello")).ok).toBe(true);
    });
  }
});

describe("createUploadUrl", () => {
  it("mints a job whose object key is namespaced by the jobId", async () => {
    const out = await createUploadUrl(ctx, { filename: "contract.pdf", sizeBytes: 1024 });
    expect(out.objectKey).toBe(`${out.jobId}/contract.pdf`);
    expect(out.bucket).toBe(bucket);
    expect(new Date(out.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a filename that tries to climb out of its prefix", async () => {
    // S3 is flatter than blob storage about this — a key is one opaque string
    // and `a/../b` is a literal key, not a traversal — but the prefix IS the
    // isolation boundary between one job's bytes and another's, so a name that
    // can reshape it is refused exactly as before.
    await expect(createUploadUrl(ctx, { filename: "../../etc/passwd", sizeBytes: 10 }))
      .rejects.toThrow(/filename/);
    await expect(createUploadUrl(ctx, { filename: "a/b.pdf", sizeBytes: 10 }))
      .rejects.toThrow(/filename/);
  });

  it("refuses an unsupported extension", async () => {
    await expect(createUploadUrl(ctx, { filename: "movie.mp4", sizeBytes: 10 }))
      .rejects.toThrow(/extension/);
  });

  it("refuses a size above the ceiling", async () => {
    await expect(createUploadUrl(ctx, { filename: "big.pdf", sizeBytes: cfg.maxUploadBytes + 1 }))
      .rejects.toThrow(/too large/);
  });

  it("refuses an over-long filename before minting a URL or creating the job row", async () => {
    // 512 is the logger's own MAX_FIELD_CHARS (shared/logger.ts) — the
    // pre-fix code let a name past this length reach
    // log.info("upload.url_minted", { filename, … }) AFTER newJobId,
    // mintUploadUrl and createJob had all already run, so the failure came
    // from inside the logger with an orphan job row and a minted URL already
    // behind it. Matching this tool's own message (not the logger's near-
    // identical one) is what proves the check fires BEFORE any of that.
    const longName = "a".repeat(509) + ".pdf"; // 513 chars, one over the cap
    // The `bad_filename:` prefix is part of the contract — `userError` puts the
    // code in front of every message because the MODEL branches on it — so the
    // match is on the whole string including it.
    await expect(createUploadUrl(ctx, { filename: longName, sizeBytes: 10 }))
      .rejects.toThrow(/^bad_filename: filename is too long: 513 chars, max 512$/);
  });
});
