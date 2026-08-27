import { Readable } from "node:stream";
import {
  S3Client, CreateBucketCommand, HeadBucketCommand, GetObjectCommand,
  HeadObjectCommand, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  SQSClient, CreateQueueCommand, GetQueueUrlCommand, SendMessageCommand,
  ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand, PurgeQueueCommand,
} from "@aws-sdk/client-sqs";
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  type Config, type BucketKey, type QueueKey,
  bucketFor, queueNameFor, UPLOADS, ARTIFACTS, WORKSPACE, JOB_QUEUE, POISON_QUEUE,
} from "./config.js";

/**
 * One AWS façade for the whole plugin.
 *
 * It exists for the same reason its Azure ancestor did — every module wants the
 * same three clients and none of them should be constructing credentials — but
 * it carries one thing the Azure version had for free and S3 does not: a
 * SECOND S3 client, `presign`, built against `publicS3Endpoint`. SigV4 signs
 * the Host header, so a presigned URL is only valid for the host it was signed
 * against; rewriting the host afterwards (which is exactly what the Azure build
 * did to a SAS, harmlessly, because a SAS signature covers no host) produces a
 * URL that 403s with a perfectly valid-looking signature. Presigning against
 * the endpoint the CALLER will use is the only correct answer, so the endpoint
 * has to be a property of a client rather than a string swap at the end.
 */
export interface Storage {
  cfg: Config;
  s3: S3Client;
  /** Used for NOTHING but `getSignedUrl`. See above. */
  presign: S3Client;
  sqs: SQSClient;
  ddb: DynamoDBDocumentClient;
  ddbRaw: DynamoDBClient;
  bucket: (key: BucketKey) => string;
  queue: (key: QueueKey) => Queue;
  jobsTable: string;
}

/** The SQS surface the worker and the orchestrator use, shaped so the code that
 *  drives it reads the way it did against Azure Queue Storage. The differences
 *  that matter are documented on each method rather than smoothed over. */
export interface Queue {
  /** Resolved once and cached: SQS addresses a queue by URL, and a GetQueueUrl
   *  round trip in front of every send would be a needless call per message. */
  url(): Promise<string>;
  sendMessage(text: string): Promise<{ messageId: string }>;
  receiveMessages(opts?: {
    numberOfMessages?: number; visibilityTimeout?: number; waitTimeSeconds?: number;
  }): Promise<{ receivedMessageItems: ReceivedMessage[] }>;
  deleteMessage(messageId: string, receiptHandle: string): Promise<void>;
  /**
   * Extends the invisibility window on a message already in flight.
   *
   * Signature kept four-argument, and the third deliberately unused, so the
   * worker's `withRenewedVisibility` reads unchanged. The RETURN is where AWS
   * and Azure genuinely differ: Azure rotates the pop receipt on every renewal,
   * which is why that helper had to thread a moving receipt through and await
   * an in-flight renewal before reading it. An SQS ReceiptHandle is stable for
   * the life of the receive, so this hands back the SAME handle. The awaiting
   * is kept anyway — it costs one already-settled promise and it means the
   * helper stays correct if this ever stops being true.
   */
  updateMessage(
    messageId: string, receiptHandle: string, _text: undefined, visibilitySeconds: number,
  ): Promise<{ popReceipt: string }>;
  /**
   * `ApproximateNumberOfMessages`, and the name is a warning rather than
   * modesty: SQS computes it across distributed hosts, it lags by up to a
   * minute, and it does NOT count messages currently in flight. Fine for an
   * operator glancing at queue depth; useless as a test assertion — a test
   * that wants to know how many messages are on a queue must receive them and
   * count what it got.
   */
  approximateDepth(): Promise<number>;
  /** Empties the queue. For a test's own setup only: SQS refuses more than one
   *  purge per queue per 60 seconds, so nothing on a hot path may call it. */
  purge(): Promise<void>;
}

export interface ReceivedMessage {
  messageId: string;
  /** SQS's ReceiptHandle. Named for its Azure counterpart because every caller
   *  already is, and because "the opaque token that lets you delete or extend
   *  THIS receipt" is precisely what both are. */
  popReceipt: string;
  messageText: string;
  /** SQS's `ApproximateReceiveCount`. "Approximate" is honest — a message can
   *  be counted twice if a worker dies between receiving and processing — and
   *  it is exactly as reliable as Azure's `dequeueCount` was for the one thing
   *  it is used for: deciding when to stop retrying a message that keeps
   *  killing whatever picks it up. */
  dequeueCount: number;
}

/** True for the SDK's several ways of saying "that object/queue/table is not
 *  there". The v3 clients are not consistent about it — S3 answers `NoSuchKey`
 *  for GetObject and a bare 404 with `name: "NotFound"` for HeadObject, and
 *  SQS has its own named exception — so every caller asking the question
 *  itself is how one of those spellings gets missed. */
export const isNotFound = (e: any): boolean =>
  e?.$metadata?.httpStatusCode === 404 ||
  e?.name === "NotFound" ||
  e?.name === "NoSuchKey" ||
  e?.name === "NoSuchBucket" ||
  e?.name === "ResourceNotFoundException" ||
  e?.name === "QueueDoesNotExist" ||
  e?.Code === "NoSuchKey";

/** DynamoDB's answer to a failed `ConditionExpression` — the direct equivalent
 *  of Table Storage's 412 on a stale etag, and the thing `start_job`'s
 *  claim-before-enqueue race turns on. */
export const isPreconditionFailed = (e: any): boolean =>
  e?.name === "ConditionalCheckFailedException" ||
  e?.$metadata?.httpStatusCode === 412;

const credentialsFor = (cfg: Config) =>
  cfg.accessKeyId && cfg.secretAccessKey
    ? {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        ...(cfg.sessionToken ? { sessionToken: cfg.sessionToken } : {}),
      }
    // Undefined, not null: handing the SDK `credentials: null` disables the
    // default provider chain outright, which is how a production deployment
    // with a perfectly good instance role starts answering
    // "Could not load credentials from any providers".
    : undefined;

const makeS3 = (
  cfg: Config, endpoint: string | null, opts: { forPresigning?: boolean } = {},
): S3Client =>
  new S3Client({
    region: cfg.region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: cfg.forcePathStyle,
    credentials: credentialsFor(cfg),
    /**
     * OFF for the presigning client, and this is not a tuning knob — leaving it
     * on produces a presigned PUT that REFUSES every upload.
     *
     * Since the SDK's default-checksums change, PutObject computes a CRC32 of
     * the request body and sends it as `x-amz-checksum-crc32`. Presigning has
     * no body, so the SDK computes the CRC32 of an EMPTY one and bakes
     * `x-amz-checksum-crc32=AAAAAA%3D%3D` into the signed query string. The
     * caller then PUTs real bytes against a URL that has already declared their
     * checksum to be the empty string's, and S3 answers:
     *
     *     400 InvalidRequest — Value for x-amz-checksum-crc32 header is invalid
     *
     * It cannot be stripped afterwards either: those parameters are part of the
     * signed canonical query string, so removing them invalidates the signature.
     * The only fix is to stop the middleware adding them, which is what
     * WHEN_REQUIRED does — S3 requires a checksum for exactly one operation
     * (DeleteObjects, which computes its own from a body we always have), so
     * nothing this plugin presigns loses anything.
     *
     * Left ON for the ordinary client, where the SDK has the real body and the
     * checksum is a genuine integrity check — including lib-storage's per-part
     * checksums on a multipart upload.
     *
     * Found by `test/presign.int.test.ts` against LocalStack: every presigned
     * upload failed, which is the whole `create_upload_url` fallback path.
     */
    ...(opts.forPresigning ? { requestChecksumCalculation: "WHEN_REQUIRED" as const } : {}),
    /**
     * OFF, on BOTH clients, because a RANGED read cannot be validated this way
     * and a ranged read is the mechanism this whole plugin exists for.
     *
     * The SDK stores a whole-object CRC32 when it writes, and by default
     * verifies the `x-amz-checksum-crc32` on every read. On a ranged GET the
     * header still describes the WHOLE object while the body is a few hundred
     * bytes out of the middle of it, so the comparison is between a checksum of
     * the file and a checksum of a fragment, and it fails:
     *
     *     Checksum mismatch: expected "dd/rIA==" but received "f+xgnw=="
     *     in response header "x-amz-checksum-crc32"
     *
     * Which is exactly what `fetch_chunks` does to `chunks.jsonl` on every
     * single call — measured, and it took out five integration tests at once.
     * WHEN_REQUIRED validates only when a request opted in with
     * `ChecksumMode: "ENABLED"`, which nothing here does.
     *
     * Nothing is given up. This plugin's integrity story is SHA-256 and always
     * was: `upload_file` hashes the bytes inside the upload stream and writes
     * the digest to the job row, the worker re-hashes what it downloads and
     * fails the job on a mismatch (`checksum_mismatch`), and `syncUp` stores a
     * SHA-256 in object metadata that `remoteManifest` compares on. A
     * transport-level CRC32 over a fragment adds nothing to any of that.
     */
    responseChecksumValidation: "WHEN_REQUIRED" as const,
  });

const makeQueue = (s: { sqs: SQSClient }, cfg: Config, key: QueueKey): Queue => {
  const name = queueNameFor(cfg, key);
  let cached: Promise<string> | null = null;
  const url = () => {
    // Resolved lazily and memoised on the PROMISE, not on its value, so two
    // concurrent first calls share one GetQueueUrl instead of racing.
    cached ??= s.sqs.send(new GetQueueUrlCommand({ QueueName: name }))
      .then((r) => {
        if (!r.QueueUrl) throw new Error(`SQS returned no URL for queue ${name}`);
        return r.QueueUrl;
      })
      .catch((e) => { cached = null; throw e; });
    return cached;
  };
  return {
    url,
    async sendMessage(text: string) {
      const r = await s.sqs.send(new SendMessageCommand({
        QueueUrl: await url(), MessageBody: text,
      }));
      return { messageId: r.MessageId ?? "" };
    },
    async receiveMessages(opts = {}) {
      const r = await s.sqs.send(new ReceiveMessageCommand({
        QueueUrl: await url(),
        MaxNumberOfMessages: opts.numberOfMessages ?? 1,
        VisibilityTimeout: opts.visibilityTimeout,
        // Long polling rather than a tight loop: an empty short poll costs a
        // request and returns instantly, so a worker with nothing to do would
        // otherwise spend its life billing for empty receives. The worker's own
        // idle delay is still there; this makes it mostly redundant, which is
        // the point.
        WaitTimeSeconds: opts.waitTimeSeconds ?? 5,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }));
      return {
        receivedMessageItems: (r.Messages ?? []).map((m) => ({
          messageId: m.MessageId ?? "",
          popReceipt: m.ReceiptHandle ?? "",
          messageText: m.Body ?? "",
          dequeueCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
        })),
      };
    },
    async deleteMessage(_messageId: string, receiptHandle: string) {
      await s.sqs.send(new DeleteMessageCommand({
        QueueUrl: await url(), ReceiptHandle: receiptHandle,
      }));
    },
    async updateMessage(
      _messageId: string, receiptHandle: string, _text: undefined, visibilitySeconds: number,
    ) {
      await s.sqs.send(new ChangeMessageVisibilityCommand({
        QueueUrl: await url(),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilitySeconds,
      }));
      return { popReceipt: receiptHandle };
    },
    async approximateDepth() {
      const r = await s.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: await url(),
        AttributeNames: ["ApproximateNumberOfMessages"],
      }));
      return Number(r.Attributes?.ApproximateNumberOfMessages ?? 0);
    },
    async purge() {
      await s.sqs.send(new PurgeQueueCommand({ QueueUrl: await url() }));
    },
  };
};

export const getStorage = (cfg: Config): Storage => {
  const s3 = makeS3(cfg, cfg.endpoint);
  const sqs = new SQSClient({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    credentials: credentialsFor(cfg),
  });
  const ddbRaw = new DynamoDBClient({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    credentials: credentialsFor(cfg),
  });
  const base = {
    cfg, s3,
    // Always its OWN client, even when the endpoint is the same one: presigning
    // needs checksum calculation off (see makeS3) and the ordinary client must
    // keep it on.
    presign: makeS3(cfg, cfg.publicS3Endpoint ?? cfg.endpoint, { forPresigning: true }),
    sqs, ddbRaw,
    ddb: DynamoDBDocumentClient.from(ddbRaw, {
      marshallOptions: { removeUndefinedValues: true },
    }),
    jobsTable: cfg.jobsTable,
  };
  const queues = new Map<QueueKey, Queue>();
  return {
    ...base,
    bucket: (key: BucketKey) => bucketFor(cfg, key),
    queue: (key: QueueKey) => {
      let q = queues.get(key);
      if (!q) { q = makeQueue(base, cfg, key); queues.set(key, q); }
      return q;
    },
  };
};

const ensureBucket = async (s: Storage, key: BucketKey): Promise<void> => {
  const Bucket = s.bucket(key);
  try {
    await s.s3.send(new HeadBucketCommand({ Bucket }));
    return;
  } catch (e: any) {
    if (!isNotFound(e) && e?.$metadata?.httpStatusCode !== 403) throw e;
    // 403 means it exists and belongs to someone else, or this identity may not
    // head it — either way CreateBucket is the honest next call and its own
    // error says which.
  }
  try {
    // us-east-1 is the one region where a LocationConstraint is REJECTED rather
    // than required. Getting this wrong is a first-run failure with a message
    // ("InvalidLocationConstraint") that names neither the region nor the fix.
    await s.s3.send(new CreateBucketCommand({
      Bucket,
      ...(s.cfg.region === "us-east-1"
        ? {}
        : { CreateBucketConfiguration: { LocationConstraint: s.cfg.region as any } }),
    }));
  } catch (e: any) {
    // Two names for "it is already there", and only one of them is benign in
    // real AWS — `BucketAlreadyExists` means somebody ELSE owns that global
    // name. It is rethrown deliberately: silently carrying on would mean every
    // upload from here on writes into a stranger's bucket or fails one call
    // later with an unrelated-looking 403.
    if (e?.name === "BucketAlreadyOwnedByYou") return;
    throw e;
  }
};

const ensureQueue = async (s: Storage, key: QueueKey): Promise<void> => {
  // CreateQueue is idempotent for an identical queue and answers with the URL,
  // so there is no create-if-not-exists dance to write.
  await s.sqs.send(new CreateQueueCommand({ QueueName: queueNameFor(s.cfg, key) }));
};

const ensureTable = async (s: Storage): Promise<void> => {
  try {
    const d = await s.ddbRaw.send(new DescribeTableCommand({ TableName: s.jobsTable }));
    if (d.Table?.TableStatus === "ACTIVE") return;
  } catch (e: any) {
    if (!isNotFound(e)) throw e;
    try {
      await s.ddbRaw.send(new CreateTableCommand({
        TableName: s.jobsTable,
        // One HASH key and nothing else. Table Storage needed a PartitionKey
        // beside the RowKey and every job used the same literal "job" for it —
        // a partition of one, which is the shape you write when the store makes
        // you name a partition and you have no natural one. DynamoDB does not,
        // so the job id alone is the key and the reads are all GetItem by id.
        KeySchema: [{ AttributeName: "jobId", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "jobId", AttributeType: "S" }],
        // On-demand: this table sees a handful of writes per job and long idle
        // stretches, which is the exact shape provisioned capacity is worst at.
        BillingMode: "PAY_PER_REQUEST",
      }));
    } catch (err: any) {
      // Two processes booting at once both find no table and both create it.
      if (err?.name !== "ResourceInUseException") throw err;
    }
  }
  // CreateTable returns before the table can be written to, so a worker that
  // boots and immediately claims a job would fail on a table that exists but is
  // still CREATING. Polled rather than slept: the wait is usually one round
  // trip against LocalStack and a few seconds against real AWS.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const d = await s.ddbRaw.send(new DescribeTableCommand({ TableName: s.jobsTable }));
    if (d.Table?.TableStatus === "ACTIVE") return;
    if (Date.now() > deadline) {
      throw new Error(`table ${s.jobsTable} did not become ACTIVE within 60s`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
};

export const ensureStorage = async (s: Storage): Promise<void> => {
  await Promise.all([
    ensureBucket(s, UPLOADS),
    ensureBucket(s, ARTIFACTS),
    ensureQueue(s, JOB_QUEUE),
    ensureQueue(s, POISON_QUEUE),
    ensureTable(s),
  ]);
};

export const ensureWorkspaceBucket = async (s: Storage): Promise<void> =>
  ensureBucket(s, WORKSPACE);

// ---------------------------------------------------------------------------
// Object helpers.
//
// The Azure SDK handed out a client per container and a client per blob, so
// call sites read `blob.getContainerClient(X).getBlockBlobClient(k).download()`.
// The v3 S3 client is one client and a command per operation, so the equivalent
// ergonomics live here as functions. Everything that touches an object goes
// through one of these — which is what makes "only ranged reads leave storage"
// and "nothing is buffered that need not be" checkable in one file.
// ---------------------------------------------------------------------------

/** A ranged GET when `range` is supplied — only those bytes leave S3, which is
 *  what keeps `fetch_chunks` constant-cost against a 100 MB chunk file. */
export const getObjectBuffer = async (
  s: Storage, bucket: string, key: string, range?: { offset: number; count: number },
): Promise<Buffer> => {
  const r = await s.s3.send(new GetObjectCommand({
    Bucket: bucket, Key: key,
    ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.count - 1}` } : {}),
  }));
  if (!r.Body) throw new Error(`object ${key} returned no body`);
  return Buffer.from(await r.Body.transformToByteArray());
};

export const getObjectStream = async (
  s: Storage, bucket: string, key: string,
): Promise<Readable> => {
  const r = await s.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!r.Body) throw new Error(`object ${key} returned no body`);
  // In Node the v3 SDK's Body IS a Readable; the union it is typed as covers
  // the browser build too.
  return r.Body as Readable;
};

/** A HEAD, never a GET, so asking an artifact's size stays cheap for a
 *  multi-hundred-megabyte chunks.jsonl. */
export const headObject = async (
  s: Storage, bucket: string, key: string,
): Promise<{ contentLength: number; metadata: Record<string, string> }> => {
  const r = await s.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return { contentLength: r.ContentLength ?? 0, metadata: r.Metadata ?? {} };
};

export const putObject = async (
  s: Storage, bucket: string, key: string, body: string | Buffer,
  opts: { contentType?: string; metadata?: Record<string, string> } = {},
): Promise<void> => {
  const input: PutObjectCommandInput = {
    Bucket: bucket, Key: key, Body: body,
    ...(opts.contentType ? { ContentType: opts.contentType } : {}),
    ...(opts.metadata ? { Metadata: opts.metadata } : {}),
  };
  await s.s3.send(new PutObjectCommand(input));
};

/** Streamed in 8 MiB parts, four in flight — so peak memory is ~32 MiB whether
 *  the source is 8 MiB or 5 GiB. `lib-storage` picks single PutObject or
 *  multipart itself and cleans up a failed multipart, which is the whole
 *  reason to use it rather than driving CreateMultipartUpload by hand. */
export const uploadStream = async (
  s: Storage, bucket: string, key: string, body: Readable,
  opts: { contentType?: string; metadata?: Record<string, string> } = {},
): Promise<void> => {
  const up = new Upload({
    client: s.s3,
    params: {
      Bucket: bucket, Key: key, Body: body,
      ...(opts.contentType ? { ContentType: opts.contentType } : {}),
      ...(opts.metadata ? { Metadata: opts.metadata } : {}),
    },
    partSize: 8 * 1024 * 1024,
    queueSize: 4,
    leavePartsOnError: false,
  });
  await up.done();
};

export interface ListedObject { key: string; size: number }

/** An async generator, so a caller consuming a large listing never holds the
 *  whole page set — the same shape `listBlobsFlat` had, and the reason
 *  `delete_job`'s purge and `remoteManifest` can both be written as loops. */
export async function* listObjects(
  s: Storage, bucket: string, prefix: string,
): AsyncGenerator<ListedObject> {
  let token: string | undefined;
  do {
    const r = await s.s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of r.Contents ?? []) {
      if (o.Key) yield { key: o.Key, size: o.Size ?? 0 };
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
}

/** Deletes in batches of 1000 — DeleteObjects' own ceiling — because a purge
 *  issuing one request per object is what makes deleting a job with thousands
 *  of artifacts take minutes. */
export const deleteObjects = async (
  s: Storage, bucket: string, keys: string[],
): Promise<number> => {
  let removed = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const r = await s.s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
    }));
    // S3 answers 200 with a per-key Errors array rather than failing the call,
    // so a purge that silently deleted nothing would otherwise report success.
    if (r.Errors?.length) {
      throw new Error(
        `failed to delete ${r.Errors.length} object(s), first: ` +
        `${r.Errors[0].Key} — ${r.Errors[0].Code}`);
    }
    removed += batch.length;
  }
  return removed;
};
