---
name: azure-file-processing
description: Use when a document is too large to read directly, or when asked to upload, process, search, summarise or extract text from a PDF, DOCX, TXT or MD file. Keeps file contents out of the context window by processing them in Azure Blob Storage and reading back only the passages that matter. Trigger on "this PDF", "large file", "search this document", "what does the contract say", or any file over a few hundred kilobytes.
---

# Azure File Processing

## The rule

**Never read the file yourself.** Do not open it, do not `cat` it, do not pass
it to any other tool, and do not summarise it from memory. A large document
read into the conversation is the exact failure this plugin exists to
prevent: it fills the context window, costs a fortune, and for anything past
a few tens of megabytes it simply will not fit.

You will only ever see: counts and headings from `get_result`, short snippets
from `search_chunks`, and the handful of passages you explicitly ask
`fetch_chunks` for. Nothing else about the file's contents should reach you.

## Before anything else

Check the backend is running:

```bash
curl -fsS http://127.0.0.1:8080/health
```

If that fails, the `azure-files` tools will not connect and will not appear.
Tell the user to run `./scripts/stack.sh up` from the plugin directory (it
waits for `/health` itself and reports when it is ready), then start a **new**
Codex thread — tools are bound when a thread begins, so an already-open thread
will not pick the server up even after it comes online.

## The sequence

Seven tools, always called in this order (search and fetch may repeat):
`create_upload_url` → `upload.mjs` → `start_job` → `job_status` →
`get_result` → `search_chunks` → `fetch_chunks` → `delete_job`.

**1 · Mint an upload URL.** Give the real filename, its size in bytes, and its
SHA-256 checksum, so the download can be verified once it lands. Only `.pdf`,
`.docx`, `.txt` and `.md` are accepted.

Get the checksum from the shell, never by reading the file yourself — one line
of output, no file content reaching you:

```bash
shasum -a 256 /path/to/contract.pdf
```

Pass the 64-character hex digest (the first field) as `sha256`:

```
create_upload_url({ filename: "contract.pdf", sizeBytes: 84213760, sha256: "<64 hex chars>" })
→ { jobId, uploadUrl, blobPath, container, expiresAt, maxSinglePutBytes }
```

`sha256` is optional, but skipping it skips the integrity check below —
always compute and pass it.

**2 · Send the bytes — from the shell, never through yourself.**

```bash
node scripts/upload.mjs /path/to/contract.pdf "<uploadUrl>"
```

The URL is write-only (it can create and write that one blob and nothing
else — it cannot read or list anything), and it expires in fifteen minutes.
`upload.mjs` streams the file straight to storage and stages it in blocks
above 64 MB; it never prints file content, only a final
`{ ok, bytes, sha256, blocks }` line as a receipt — compare it against the
`shasum` output from step 1 if you want to double-check by eye. Never paste
file contents into a tool call. If you passed `sha256` in step 1, the worker
verifies the downloaded bytes against it once processing starts and fails the
job on a mismatch (`checksum_mismatch`, see the table below) — a corrupted or
truncated upload cannot silently produce a document made of different bytes
than the ones you described.

**3 · Start the job.**

```
start_job({ jobId })
→ { jobId, state, queuedAt, alreadyStarted }
```

Optional tuning: `pipeline: { id: "extract-chunks", params: { chunkChars, overlapChars, pageWindow } }`.
Calling this again on a job already queued or running is safe — it reports
the current state instead of enqueueing a second run.

**4 · Poll until it finishes.** Every few seconds; a large document takes
minutes.

```
job_status({ jobId })
→ { jobId, state, phase, progress: { done, total, unit: "pages" }, attempts, ... }
```

`state` moves `awaiting_upload → queued → running → succeeded` (or `failed`).
`phase` narrows `running` to `downloading` / `extracting` / `chunking` /
`uploading`. Tell the user what stage it is at rather than going quiet for
minutes at a time.

**5 · Get the facts.**

```
get_result({ jobId })
→ { jobId, result: { pages, words, chunks, language, headings, tables, durationMs }, artifacts }
```

This never contains passage text — `headings` (up to 50 short section
titles) is the one bounded exception, there to help you orient before you
search. Use it to decide what to search for next, not to answer the
question.

**6 · Read only what you need.**

```
search_chunks({ jobId, query: "termination", topK: 5 })
→ { jobId, hits: [{ chunkId, pageStart, pageEnd, snippet, score }], scannedBytes, scannedChunks, truncated }

fetch_chunks({ jobId, chunkIds: ["c-000412"] })
→ { jobId, chunks: [{ chunkId, pageStart, pageEnd, text }], bytes, truncated }
```

Search first, fetch second — never fetch a chunk id you have not seen from a
search result. Fetch at most ten chunk ids per call, and expect a 32 KB
ceiling on the total text returned.

**`truncated: true` means something different on each tool, and neither one
means "nothing matched":**

- On `search_chunks`, it means the scan stopped at its byte ceiling before
  reaching the end of the document — a very large file can have content past
  that point that was never scanned. If your terms are highly specific to a
  late section, no hits does not prove the document doesn't say it. Narrow
  the query to terms more likely to appear earlier, or say plainly that
  search did not reach the whole document.
- On `fetch_chunks`, it means you asked for more chunk text than the 32 KB
  cap allows in one call and some of the requested chunks were left out.
  Ask for fewer chunk ids, not more.

**7 · Clean up, when the user asks — never on your own initiative.**

```
delete_job({ jobId })
→ { jobId, deleted: true, blobsRemoved }
```

This permanently removes the uploaded file and every artifact. Only do it
when the user asks you to, since it cannot be undone.

## Answering questions about a document

Search for the terms the question actually uses, fetch the two or three best
chunks, and answer **from those** — never from `get_result`'s headings alone,
which are not evidence, only orientation.

Cite a **page range**, not a single page: every chunk carries `pageStart` and
`pageEnd` because a chunk routinely spans a page boundary, so "page 37" can
be wrong when the real answer is "pages 37–38". Say "pages 37–38 of
contract.pdf" rather than "the document says" — a citation costs nothing and
an uncited claim from a document you never read yourself is unverifiable.

If the snippets do not answer the question, search again with different
terms — never fetch more and more chunks hoping to stumble on the answer.

## When it goes wrong

| What you see | What it means |
|---|---|
| `unknown job <id>` | Wrong `jobId`, or the stack was reset. Start again from `create_upload_url`. |
| `job <id> was not uploaded` | `start_job` ran before the upload finished, or the upload failed. Re-run `upload.mjs`, then retry. |
| `size mismatch: declared … bytes, storage holds …` | The upload was incomplete or interrupted. Re-run `upload.mjs`. |
| `checksum_mismatch: declared …, downloaded …` | The bytes the worker downloaded do not match the `sha256` you passed to `create_upload_url`. The upload was corrupted or truncated — re-run `shasum -a 256` and `upload.mjs`, and pass the fresh digest. |
| `job <id> is not ready: state is <state>` | `get_result`, `search_chunks` or `fetch_chunks` was called before the job reached `succeeded`. Poll `job_status` until it does. |
| `unsupported extension` | Only `.pdf`, `.docx`, `.txt`, `.md` are accepted. A scanned PDF with no text layer will upload and process but yield almost no text — say so rather than guessing at what it "must" say. |
| `state: "failed"` with an `error` field | Read `error` verbatim and report it. A file that keeps failing is dead-lettered after a few attempts rather than retried forever. |
| SAS / upload URL rejected as expired | The URL lasts fifteen minutes from `create_upload_url`. Call it again for a fresh one. |
| `at most 10 chunk ids per call` / `at most 20` topK | You asked for more than the tool allows. Split the request. |
| No `azure-files` tools available at all | The stack is not running, or this thread started before it came up. See *Before anything else*. |
