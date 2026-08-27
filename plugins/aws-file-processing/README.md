# AWS File Processing

Two MCP servers and one skill. Together they let Claude Code drive the Scyne
requirements pipeline and question documents far larger than any context window,
by keeping every byte of those documents in AWS and out of the conversation.

| Plane | Server | Port | For |
|---|---|---|---|
| **file** | `scyne` | 8080 | large documents in, page-cited passages out |
| **workspace** | `scyne-workspace` | 8081 | projects, documents, pipeline stages, gates, spend |

Either runs without the other. The file plane needs only S3, SQS and DynamoDB;
the workspace plane needs the Scyne stack (orchestrator `:3100`, chatbot
`:4000`) already running on the same machine.

This is the AWS port of `plugins/azure-file-processing`, for Claude Code rather
than Codex. What changed, and what did not, is set out under
**[Porting notes](#porting-notes)** — read that first if you know the Azure one.

## Install

It is a local plugin, registered in the repo's Claude Code marketplace at
`.claude-plugin/marketplace.json`:

```
/plugin marketplace add .
/plugin install aws-file-processing@scyne
```

Then start a NEW Claude Code session — MCP tools and skills bind at session
start, so a plugin installed mid-session provides nothing until you restart.

## Running the stack

```bash
# Terminal 1 — repo root. The Scyne stack the workspace plane fronts.
npm run dev                     # orchestrator :3100, chatbot :4000

# Terminal 2 — this plugin. LocalStack + workers in Docker,
# both MCP servers natively.
cd plugins/aws-file-processing
npm install
./scripts/stack.sh up
```

`stack.sh up` runs the orchestrator **natively** on purpose. A container's
filesystem is the image's, so `upload_file({path: "/Users/you/contract.pdf"})`
would resolve to nothing inside one. LocalStack and the workers stay
containerised — neither ever touches a path a caller named.

`./scripts/stack.sh up --all-docker` puts the orchestrator in a container too.
Then `upload_file` is **not offered at all** (`ALLOW_LOCAL_PATH_UPLOAD: "false"`
in `docker-compose.yml`), and `create_upload_url` + `scripts/upload.mjs` is the
only way in.

| Verb | Does |
|---|---|
| `up [--all-docker]` | start everything |
| `down` | stop everything and drop the LocalStack volume |
| `status` | compose state plus both `/health` endpoints |
| `logs` | follow the container logs and both native logs |
| `workers <n>` | scale the worker pool — `0` before the integration suite, `3` before acceptance |

## Tools

**File plane (`scyne`, :8080)** — eight, and the order they are called in:

| Tool | Does |
|---|---|
| `upload_file` | **the default.** Absolute path in; streams to S3 as an 8 MiB multipart upload, hashes inline, queues the job. One call. |
| `create_upload_url` | fallback for a file that is not on this machine: a presigned, write-only PUT for one object key, fifteen minutes |
| `start_job` | queue an already-uploaded object. Idempotent |
| `job_status` | `awaiting_upload → queued → running → succeeded`/`failed`, with a phase |
| `get_result` | computed facts and artifact sizes. Never passage text |
| `search_chunks` | short snippets with page citations and chunk ids |
| `fetch_chunks` | the full text of up to ten chunks, 32 KB per call |
| `delete_job` | permanently remove the upload and every artifact |

**Workspace plane (`scyne-workspace`, :8081)** — thirty-two, listed in the
doc comment at the top of `src/workspace/mcp.ts` and asserted against it by
`test/workspace-tools.test.ts`, so a tool added without a line there fails the
build rather than going undocumented.

### Five artifacts, not four

Every succeeded job writes five objects under `<artifacts bucket>/<jobId>/`:

| Artifact | What it is |
|---|---|
| `document.md` | the whole document as markdown. Listed, never returned inline — it exists so `ingest_document` can file it into a project, and so a format with no page text (a deck, a spreadsheet) is still searchable |
| `chunks.jsonl` | one JSON object per chunk, in document order |
| `index.json` | chunk id → byte offset and length in `chunks.jsonl`. This is what makes `fetch_chunks` a **ranged** GET rather than a download |
| `metadata.json` | pages, title, producer |
| `result.json` | the completion marker, uploaded **last** |

`result.json` being last is the whole failure-recovery strategy: `get_result`
refuses any job whose recorded state is not `succeeded`, so a partial set —
some objects present, `result.json` absent — is never read as complete. Every
upload is idempotent by key, so a retry simply overwrites whatever was left.

## Environment

Everything is read from the **workspace-root `.env`**, found by walking up for
`agent-instructions/` + `skills/`, so it is cwd-independent. An existing
environment variable always wins over the file.

### AWS

| Variable | Default | Notes |
|---|---|---|
| `AWS_ENDPOINT_URL` | LocalStack, only when nothing else is configured | The SDK's own standard variable. Set it for LocalStack or MinIO; leave it unset for real AWS |
| `AWS_REGION` | `us-east-1` | Setting a real region is also what stops the LocalStack default applying |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | provider chain | Leave both unset in production: the default chain (env, shared config, SSO, instance/task role) is the point |
| `S3_FORCE_PATH_STYLE` | true when a custom endpoint is set | Required by LocalStack and MinIO, wrong against real AWS |
| `S3_UPLOADS_BUCKET` | `scyne-uploads` | A bucket name is globally unique across every AWS account, so these are **not** fixed strings |
| `S3_ARTIFACTS_BUCKET` | `scyne-artifacts` | |
| `S3_WORKSPACE_BUCKET` | `scyne-workspace` | |
| `SQS_JOB_QUEUE` | `scyne-job-queue` | |
| `SQS_POISON_QUEUE` | `scyne-job-queue-poison` | |
| `DYNAMODB_JOBS_TABLE` | `scyne-jobs` | |
| `S3_PUBLIC_ENDPOINT` | — | The endpoint a **presigned URL is signed against**. Not cosmetic — see below |

**`S3_PUBLIC_ENDPOINT` is the one setting whose absence produces a mysterious
failure.** SigV4 signs the Host header. A URL presigned against
`http://localstack:4566` (what the orchestrator reaches inside Compose) and used
at `http://127.0.0.1:4566` (what curl on the host reaches) is not merely
pointing at the wrong place — it is cryptographically invalid, and answers 403
with a signature that looks perfectly well formed. So a **second S3 client** is
built against this endpoint and used for nothing but presigning
(`shared/storage.ts`). Its Azure ancestor could get away with a string swap on
the finished URL, because a SAS signature covers no host.

### The plugin

| Variable | Default | Notes |
|---|---|---|
| `ORCH_PORT` | `8080` | file plane |
| `WORKSPACE_PORT` | `8081` | workspace plane |
| `MCP_BEARER_TOKEN` | — | setting one also turns `upload_file` **off** by default: a token is the only reason to set one, so the endpoint is exposed, and a remote server resolving a local path is a nonsense |
| `ALLOW_LOCAL_PATH_UPLOAD` | `!MCP_BEARER_TOKEN` | |
| `PRESIGN_TTL_SECONDS` | `900` | |
| `MAX_UPLOAD_BYTES` | `5368709120` | 5 GiB, which is also S3's own single-object PUT ceiling |
| `FETCH_MAX_BYTES` | `32768` | per `fetch_chunks` call |
| `SEARCH_MAX_SCAN_BYTES` | `134217728` | `truncated: true` above this |
| `DEFAULT_CHUNK_CHARS` / `DEFAULT_OVERLAP_CHARS` / `DEFAULT_PAGE_WINDOW` | `4000` / `200` / `25` | |
| `MAX_DEQUEUE_COUNT` | `3` | then dead-lettered |
| `MARKDOWN_MAX_BYTES` | heap ÷ 12, capped at 256 MiB | above it, `document.md` is written by the streaming extractor |
| `TEMP_DIR` | `/tmp/afp` | swept at worker startup |

### The workspace plane

| Variable | Default | Notes |
|---|---|---|
| **`SCYNE_ORCH_TOKEN`** | — | **required.** Without it every workspace tool answers `not_authenticated`. Same Bearer token the `scyne` CLI uses |
| `SCYNE_ORCH_URL` | `http://127.0.0.1:3100` | |
| `SCYNE_CHATBOT_URL` | `http://127.0.0.1:${CHATBOT_PORT:-4000}` | |
| `WORKSPACE_PATH` | the walked-up workspace root | where `projects/<project>/…` lives |

The file plane needs none of that; it only needs `:8080`.

## IAM

The orchestrator and the worker want the same three services and nothing else.
Scoped to the plugin's own buckets, queues and table:

```
s3:CreateBucket, s3:ListBucket, s3:GetObject, s3:PutObject, s3:DeleteObject,
s3:AbortMultipartUpload, s3:ListBucketMultipartUploads, s3:ListMultipartUploadParts
  on  arn:aws:s3:::scyne-uploads, arn:aws:s3:::scyne-artifacts,
      arn:aws:s3:::scyne-workspace  (and /* on each)

sqs:CreateQueue, sqs:GetQueueUrl, sqs:SendMessage, sqs:ReceiveMessage,
sqs:DeleteMessage, sqs:ChangeMessageVisibility
  on  the job queue and its poison queue

dynamodb:CreateTable, dynamodb:DescribeTable,
dynamodb:GetItem, dynamodb:PutItem, dynamodb:UpdateItem
  on  the jobs table
```

A presigned URL can never grant more than the identity that signed it, so the
narrowing a service SAS did with `permissions: "cw"` is done here by this
policy. Give the orchestrator `s3:PutObject` on the uploads bucket only, and a
presigned upload URL cannot become a read of anything.

## Development loop

```bash
npm run typecheck
npm test                        # unit — no infrastructure at all
./scripts/stack.sh workers 0    # a live worker steals the integration suite's messages
npm run test:integration        # against LocalStack
./scripts/stack.sh workers 3
npm run test:acceptance         # end to end, including the bounded-memory job
```

**Measured on this port:** 188 unit tests pass with no infrastructure at all;
144 integration tests pass against LocalStack alone. One integration file,
`orchestrator-tools.int.test.ts`, additionally needs the Scyne stack (`npm run
dev` at the repo root) and fails loudly rather than skipping when it is not
there — a silently skipped integration suite is a green build that proves
nothing. The acceptance suite needs the Docker worker pool and has not been run
on this port; its fixture sizes and the ~84% scan boundary it asserts are
figures inherited from the Azure build (the code paths that decide them are
unchanged, but they are not re-measured).

After changing anything the model reads — a tool description, `SKILL.md`,
`commands/scyne.md` — restart the servers and then start a **new Claude Code
session**: tools and skills are bound at session start.

## Verifying an install

```bash
curl -fsS http://127.0.0.1:8080/health   # {"ok":true,"service":"aws-files",...}
curl -fsS http://127.0.0.1:8081/health   # {"ok":true,"service":"scyne-workspace",...}
curl -fsS http://127.0.0.1:3100/health   # the Scyne orchestrator
curl -fsS http://127.0.0.1:4000/api/features
```

Then, in Claude Code, `/scyne` with no verb. It reports the pinned target if
there is one, lists what is runnable, and lists what is waiting on a person — so
it exercises both planes in one call.

## The sync CLI

`projects/<project>/` is mirrored into the workspace bucket, content-addressed
by SHA-256 held in object metadata:

```bash
./node_modules/.bin/tsx scripts/sync.mjs <project> --status
./node_modules/.bin/tsx scripts/sync.mjs <project> --up [--prefix P] [--dry-run]
./node_modules/.bin/tsx scripts/sync.mjs <project> --down    # restore only
```

It must run through the plugin's own `tsx` — it imports `.ts` files from `src/`,
and bare `node` fails with `ERR_MODULE_NOT_FOUND`.

**`--up` never deletes**, so an accidental `rm -rf projects/` followed by a push
cannot destroy the durable copy. **`--down` is a restore path only**: S3 is an
export, not a second source of truth, and `test/sync-one-way.test.ts` asserts
that nothing under `src/` imports `syncDown`.

## `/scyne` — the command surface

Three surfaces, one body on disk:

| Surface | File | When it fires |
|---|---|---|
| slash command | `commands/scyne.md` | somebody types `/scyne run datamodel` |
| skill | `skills/scyne/SKILL.md` | on its own, when somebody mentions a large PDF or a pipeline stage |
| MCP prompt | served by `scyne-workspace` | any client that reads `prompts/list` |

All three load `skills/scyne/SKILL.md` at call time rather than duplicating it,
so editing the skill updates every surface and they cannot drift.

## Porting notes

What this shares with `plugins/azure-file-processing`, and what it does not.

### The service mapping

| Azure | AWS | Consequence |
|---|---|---|
| Blob Storage container | S3 bucket | Bucket names are **globally unique**, so they are configuration rather than the literals `uploads`/`artifacts`/`workspace`. `bucketFor(cfg, UPLOADS)` is the one place the mapping happens |
| Queue Storage | SQS | `dequeueCount` → `ApproximateReceiveCount`; pop receipt → `ReceiptHandle`, which **does not rotate** on a visibility change |
| Table Storage | DynamoDB | No `PartitionKey` was needed: every job used the literal `"job"`, a partition of one. The job id alone is the key |
| entity ETag + `If-Match` | a `rev` attribute + `ConditionExpression` | DynamoDB has no server-maintained ETag, so optimistic concurrency is an ordinary attribute every write bumps. `Job.etag` is still the field name, because no caller does arithmetic on it |
| Azurite | LocalStack | one container, S3 + SQS + DynamoDB on `:4566` |
| service SAS | presigned PUT | see `S3_PUBLIC_ENDPOINT` above — this is the only place the port is genuinely harder rather than simpler |
| `uploadStream` in 8 MiB blocks | `@aws-sdk/lib-storage` `Upload`, 8 MiB parts, 4 in flight | same bounded ~32 MiB memory cost |
| block staging in `upload.mjs` | one streamed PUT | S3's single-PUT ceiling is 5 GiB, the same as `MAX_UPLOAD_BYTES`, so the `<BlockList>` XML protocol is simply gone |

### Two SDK defaults that had to be turned off

Both were found by running the integration suite, both broke a core mechanism,
and neither is guessable from its error message. They are the only places this
port needed a decision rather than a translation.

**`requestChecksumCalculation: "WHEN_REQUIRED"` on the presigning client.**
The SDK computes a CRC32 of the request body for PutObject. Presigning has no
body, so it computes the CRC32 of an *empty* one and bakes
`x-amz-checksum-crc32=AAAAAA%3D%3D` into the signed query string. The caller
then PUTs real bytes against a URL that has already declared their checksum to
be the empty string's, and S3 answers `400 InvalidRequest — Value for
x-amz-checksum-crc32 header is invalid`. It cannot be stripped afterwards
either: those parameters are inside the signed canonical query string. Without
this, **every presigned upload fails** — the whole `create_upload_url` path.
Because it must differ from the ordinary client, `storage.presign` is always
its own client, even when the endpoint is identical.

**`responseChecksumValidation: "WHEN_REQUIRED"` on both clients.** The SDK
stores a whole-object CRC32 on write and verifies it on every read. On a
**ranged** GET the header still describes the whole object while the body is a
few hundred bytes from the middle of it, so it compares a checksum of the file
against a checksum of a fragment and fails. That is what `fetch_chunks` does to
`chunks.jsonl` on every call — five integration tests at once.

Nothing is given up by turning it off. This plugin's integrity story is SHA-256
and always was: `upload_file` hashes inside the upload stream and writes the
digest to the job row, the worker re-hashes what it downloads and fails the job
on a mismatch, and `syncUp` stores a SHA-256 in object metadata that
`remoteManifest` compares on.

### The one place S3 costs a call Azure did not

`listBlobsFlat({ includeMetadata: true })` returned every blob's user metadata
inline, so a remote manifest was one paginated LIST. `ListObjectsV2` returns
key, size, ETag and storage class and **nothing user-defined**, and the SHA-256
this plugin compares on lives in object metadata. So `remoteManifest` does a
LIST to enumerate and then one `HeadObject` per key, sixteen in flight.

Rejected alternatives, since the extra call is the obvious thing to want to
avoid: the ETag is an MD5 for a single-part upload and a hash-of-hashes for a
multipart one, so it is neither the digest we compare on nor stable across part
sizes; S3's own `ChecksumSHA256` is per-part for a multipart upload and still
needs a per-object call to read; and a manifest object written beside the tree is
a third opinion about what a project contains, which is exactly what `syncDown`'s
own doc comment says must not exist.

### The one behaviour that genuinely differs

**Object storage has no directories.** A project restored with `--down` comes
back with every FILE in place and none of the empty scaffold folders nothing
ever wrote to — an untouched `requirements/UI/`, an empty `documents/` before
the first upload. Anything that expects a directory to exist before it can write
into it (a `readdir` with no `mkdir` first) is the failure mode to watch for.
This was true of blob storage too and is called out in the root `CLAUDE.md`; it
is repeated here because it is the difference people trip on.

### What did not change

The chunker, the page extractors, the markdown engines, the artifact contract,
every tool name and description, the error vocabulary, the skill, the
bounded-memory guarantee and the acceptance suite are all the same. So is the
rule the whole thing exists for: **a document's contents never enter a tool
response.**

### Three tests deliberately not ported

`plugins/azure-file-processing/test/` has three files this plugin does not:

- **`dual-write.int.test.ts`** — it calls `createProject` against the live
  chatbot, which really does create an Azure DevOps project on the client's
  tenant. That suite's own header records two stray projects it left in
  `Scyne-AI-Lab` on its first run and states that it deliberately never cleans
  up. Porting it would mean a second suite able to create client-tenant
  resources, so it is left where it is rather than duplicated.
- **`upload-hook.int.test.ts`** and **`stage-hook.int.test.ts`** — both assert
  the REPO ROOT's wiring (`scyne-chatbot/server/index.ts`'s sync hook and
  `scripts/stage.mjs`), which still points at the Azure plugin. See below.
  `sync-cli.int.test.ts` covers this plugin's own CLI over the same code path.

### Not rewired

The repo root still points its workflow sync step, `scripts/stage.mjs`,
`DEMO.sh` and `.agents/plugins/marketplace.json` at
`plugins/azure-file-processing`. This plugin is installed **alongside** it and
changes nothing about the running system. Switching the root over is a separate,
deliberate edit.

## Known limits

- **A presigned single PUT has no per-part retry.** A connection that drops
  4 GiB in restarts from zero. `upload_file` does a real multipart upload and is
  the preferred door for anything large; the presigned path exists for a file
  that is not on the server's machine.
- **`ApproximateReceiveCount` is approximate.** A worker killed between
  receiving and processing can have a message counted without ever touching it,
  so dead-lettering can fire one attempt early. That is the safe side.
- **`upload_file` only exists where the server and the file share a machine.**
  Not a lesser feature elsewhere — a remote server resolving a local path reads
  whatever happens to sit at that path on the SERVER.
- **The workspace plane binds `127.0.0.1` only.** It holds a token that can start
  paid agent runs.
