#!/usr/bin/env node
// Sends a local file to a SAS URL. Bytes go from disk to storage; they never
// pass through the model, and this script never prints file content.
//
//   node scripts/upload.mjs <file> <uploadUrl>
import { createReadStream, statSync } from "node:fs";
import { createHash } from "node:crypto";

const SINGLE_PUT_LIMIT = 64 * 1024 * 1024; // matches MAX_SINGLE_PUT_BYTES
const BLOCK_SIZE = 32 * 1024 * 1024;

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

const readRange = (path, start, end) =>
  new Promise((resolve, reject) => {
    const parts = [];
    createReadStream(path, { start, end })
      .on("data", (c) => parts.push(c))
      .on("end", () => resolve(Buffer.concat(parts)))
      .on("error", reject);
  });

let size;
try {
  ({ size } = statSync(file));
} catch (e) {
  fail("could not read file", e.message);
}
const digest = await sha256OfFile(file).catch((e) => fail("could not read file", e.message));
const sep = uploadUrl.includes("?") ? "&" : "?";

if (size <= SINGLE_PUT_LIMIT) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "content-length": String(size) },
    body: createReadStream(file),
    duplex: "half",
  }).catch((e) => fail("could not reach storage", e.message));
  if (!res.ok) fail(`storage answered ${res.status}`);
  console.log(JSON.stringify({ ok: true, bytes: size, sha256: digest, blocks: 1 }));
  process.exit(0);
}

// Block staging. Each block is uploaded independently, then one commit call
// makes the blob appear at full length — so a 2 GiB file never needs a 2 GiB
// request, and a failed block retries alone.
const blockIds = [];
let offset = 0;
let n = 0;
while (offset < size) {
  const end = Math.min(offset + BLOCK_SIZE, size) - 1;
  const id = Buffer.from(String(n).padStart(8, "0")).toString("base64");
  const body = await readRange(file, offset, end)
    .catch((e) => fail("could not read file", e.message));
  const res = await fetch(`${uploadUrl}${sep}comp=block&blockid=${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-length": String(body.length) },
    body,
  }).catch((e) => fail("could not reach storage", e.message));
  if (!res.ok) fail(`block ${n} rejected with ${res.status}`);
  blockIds.push(id);
  offset = end + 1;
  n += 1;
  process.stderr.write(`\rstaged ${n} block(s), ${offset}/${size} bytes`);
}
process.stderr.write("\n");

const list =
  `<?xml version="1.0" encoding="utf-8"?><BlockList>` +
  blockIds.map((id) => `<Latest>${id}</Latest>`).join("") +
  `</BlockList>`;
const commit = await fetch(`${uploadUrl}${sep}comp=blocklist`, {
  method: "PUT",
  headers: { "content-type": "application/xml" },
  body: list,
}).catch((e) => fail("could not reach storage", e.message));
if (!commit.ok) fail(`commit rejected with ${commit.status}`);

console.log(JSON.stringify({ ok: true, bytes: size, sha256: digest, blocks: blockIds.length }));
