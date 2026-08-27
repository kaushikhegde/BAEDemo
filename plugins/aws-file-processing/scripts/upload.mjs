#!/usr/bin/env node
// Sends a local file to a presigned S3 PUT URL. Bytes go from disk to storage;
// they never pass through the model, and this script never prints file content.
//
//   node scripts/upload.mjs <file> <uploadUrl>
//
// This is far shorter than its Azure ancestor, and the reason is worth knowing.
// A SAS PUT topped out at 5000 MiB and anything over 64 MiB had to be staged as
// individual blocks and committed with a hand-written <BlockList> XML document,
// so this script carried a whole second protocol. S3's single-PutObject ceiling
// is 5 GiB — the same as this plugin's own MAX_UPLOAD_BYTES — so one streamed
// PUT covers everything the plugin will accept, and there is no block staging
// to get wrong.
//
// The cost is honest: a single PUT has no per-part retry, so a connection that
// drops 4 GiB in restarts from zero. `upload_file` on the MCP server does a real
// multipart upload with 8 MiB parts and is the preferred door for anything
// large; this exists for when the file is not on the server's machine.
import { createReadStream, statSync } from "node:fs";
import { createHash } from "node:crypto";

const S3_SINGLE_PUT_LIMIT = 5 * 1024 * 1024 * 1024; // 5 GiB

const [, , file, uploadUrl] = process.argv;
if (!file || !uploadUrl) {
  console.error("usage: upload.mjs <file> <uploadUrl>");
  process.exit(2);
}

const fail = (why, extra = "") => {
  // Deliberately never includes the body, and never the signed URL.
  console.error(`upload failed: ${why}${extra ? ` (${extra})` : ""}`);
  process.exit(1);
};

const sha256OfFile = (path) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

let size;
try {
  ({ size } = statSync(file));
} catch (e) {
  fail("could not read file", e.message);
}
if (size === 0) fail("file is empty");
if (size > S3_SINGLE_PUT_LIMIT) {
  fail(`file is ${size} bytes; a single presigned PUT tops out at ${S3_SINGLE_PUT_LIMIT}`);
}

// Hashed in its own pass, before the upload, because the PUT below streams
// straight from disk to the network and a tee would have to buffer to keep the
// two in step. `upload_file` on the server hashes inline for exactly that
// reason — it owns both ends of the stream and this script does not.
const digest = await sha256OfFile(file).catch((e) => fail("could not read file", e.message));

const res = await fetch(uploadUrl, {
  method: "PUT",
  // content-length is required: a presigned PUT cannot be chunked-encoded, and
  // without it fetch would send `Transfer-Encoding: chunked` and S3 would
  // refuse the request.
  headers: { "content-length": String(size) },
  body: createReadStream(file),
  duplex: "half",
}).catch((e) => fail("could not reach storage", e.message));

if (!res.ok) {
  // 403 here is almost always an EXPIRED url (they last fifteen minutes) or one
  // signed against a different host than the one being used — SigV4 covers the
  // Host header, so a URL that has been rewritten is cryptographically invalid
  // however correct it looks. Say both, since neither is guessable from "403".
  const hint = res.status === 403
    ? " — the URL has expired, or it was signed against a different endpoint than the one you used"
    : "";
  fail(`storage answered ${res.status}${hint}`);
}

console.log(JSON.stringify({ ok: true, bytes: size, sha256: digest }));
