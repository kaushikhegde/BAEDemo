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

If that fails, the tools will not connect and will not appear. Tell the user
to run `./scripts/stack.sh up` from the plugin directory (it waits for
`/health` itself and reports when it is ready), then start a **new** Codex
thread — tools are bound when a thread begins, so an already-open thread will
not pick the server up even after it comes online.

## The sequence

Hand the file over with **one call**, then read what you need:
`upload_file` → `job_status` → `get_result` → `search_chunks` →
`fetch_chunks` → `delete_job`. Search and fetch may repeat.

**1 · Upload it.** Give the absolute path. That is the whole step.

```
upload_file({ path: "/Users/you/Downloads/contract.pdf" })
→ { jobId, state: "queued", filename, blobPath, bytes, sha256, started: true }
```

The server opens the file, streams it to storage in blocks, records the
SHA-256 of the bytes it actually sent, and queues the job — in that one call.
Only `.pdf`, `.docx`, `.txt` and `.md` are accepted.

**Do not** run `shasum`, **do not** run `upload.mjs`, and **do not** read one
byte of the file to "check" it first. The checksum is computed for you and
verified by the worker when it downloads; there is nothing left for you to
do here, and every one of those steps is a way to put file content somewhere
it should not be.

Pass `start: false` if the user wants the file uploaded but not processed yet;
`start_job({ jobId })` runs it later.

You will be told the path or asked to find one. If the user names a file
without a full path, ask for it or resolve it with `ls`/`find` — **never**
by reading the file.

**2 · Poll until it finishes.** Every few seconds; a large document takes
minutes.

```
job_status({ jobId })
→ { jobId, state, phase, progress: { done, total, unit: "pages" }, attempts, ... }
```

`state` moves `queued → running → succeeded` (or `failed`). `phase` narrows
`running` to `downloading` / `extracting` / `chunking` / `uploading`. Tell the
user what stage it is at rather than going quiet for minutes at a time.

**3 · Get the facts.**

```
get_result({ jobId })
→ { jobId, result: { pages, words, chunks, language, headings, tables, durationMs }, artifacts }
```

This never contains passage text — `headings` (up to 50 short section
titles) is the one bounded exception, there to help you orient before you
search. Use it to decide what to search for next, not to answer the
question.

**4 · Read only what you need.**

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

**5 · Clean up, when the user asks — never on your own initiative.**

```
delete_job({ jobId })
→ { jobId, deleted: true, blobsRemoved }
```

This permanently removes the uploaded file and every artifact. Only do it
when the user asks you to, since it cannot be undone.

## When `upload_file` is not offered

It exists only where the server and the file are on one machine. On a stack
whose orchestrator runs in a container, or one reachable over a network, the
tool is **not registered at all** — if you cannot see it in your tool list,
that is why, and it is deliberate. Fall back to the three-step path, which
does the same job with the bytes travelling from the shell instead:

**1 · Mint an upload URL.** Give the real filename, its size in bytes, and its
SHA-256 checksum, taken from the shell — never by reading the file:

```bash
shasum -a 256 /path/to/contract.pdf
```

```
create_upload_url({ filename: "contract.pdf", sizeBytes: 84213760, sha256: "<64 hex chars>" })
→ { jobId, uploadUrl, blobPath, container, expiresAt, maxSinglePutBytes }
```

**2 · Send the bytes — from the shell, never through yourself.**

```bash
node scripts/upload.mjs /path/to/contract.pdf "<uploadUrl>"
```

The URL is write-only (it can create and write that one blob and nothing
else — it cannot read or list anything), and it expires in fifteen minutes.
`upload.mjs` streams the file straight to storage and stages it in blocks
above 64 MB; it never prints file content, only a final
`{ ok, bytes, sha256, blocks }` line as a receipt. Never paste file contents
into a tool call.

**3 · Start the job.**

```
start_job({ jobId })
→ { jobId, state, queuedAt, alreadyStarted }
```

Optional tuning, on either path:
`pipeline: { id: "extract-chunks", params: { chunkChars, overlapChars, pageWindow } }`.
Calling `start_job` again on a job already queued or running is safe — it
reports the current state instead of enqueueing a second run.

From here the sequence rejoins at step 2 above: poll `job_status`.

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
| `path must be absolute` | You passed a relative path. It would have resolved against the *server's* working directory, not the user's. Resolve it first (`pwd`, `ls`) and pass the full path. |
| `no such file: <path>` | The path does not exist on the machine the server runs on. Check it with `ls`, and note this tool cannot reach another machine's disk. |
| `not a regular file` | The path is a directory (or a link to one). Name the document itself. |
| `file is empty` | Zero bytes. Processing it would produce a document that appears to say nothing, which reads downstream as a real answer — say the file is empty instead. |
| `upload_file is disabled` | This orchestrator does not read the caller's filesystem. Use the fallback path above. |
| `upload failed after N of M bytes` | The stream to storage broke part-way. The job is recorded `failed` with the reason; call `upload_file` again for a fresh one. |
| `unknown job <id>` | Wrong `jobId`, or the stack was reset. Start again from `upload_file`. |
| `job <id> was not uploaded` | `start_job` ran before an upload finished, or the upload failed. Only reachable on the fallback path — re-run `upload.mjs`, then retry. |
| `size mismatch: declared … bytes, storage holds …` | The upload was incomplete or interrupted, or the file changed while it was being read. Upload it again. |
| `checksum_mismatch: declared …, downloaded …` | The bytes the worker downloaded do not match the digest recorded at upload. Upload it again. |
| `job <id> is not ready: state is <state>` | `get_result`, `search_chunks` or `fetch_chunks` was called before the job reached `succeeded`. Poll `job_status` until it does. |
| `unsupported extension` | Only `.pdf`, `.docx`, `.txt`, `.md` are accepted. A scanned PDF with no text layer will upload and process but yield almost no text — say so rather than guessing at what it "must" say. |
| `file too large` | Over `MAX_UPLOAD_BYTES` (5 GiB by default). |
| `state: "failed"` with an `error` field | Read `error` verbatim and report it. A file that keeps failing is dead-lettered after a few attempts rather than retried forever. |
| SAS / upload URL rejected as expired | Fallback path only: the URL lasts fifteen minutes from `create_upload_url`. Call it again for a fresh one. |
| `at most 10 chunk ids per call` / `at most 20` topK | You asked for more than the tool allows. Split the request. |
| No tools available at all | The stack is not running, or this thread started before it came up. See *Before anything else*. |
