import { randomBytes } from "node:crypto";

/** Sortable by creation time, and free of every character that would be
 *  awkward in the two places a job id is also a PATH: an S3 object key prefix
 *  (`<jobId>/<name>`) and a URL. DynamoDB would accept far more in a partition
 *  key than Table Storage's RowKey did — it takes any UTF-8 up to 2048 bytes —
 *  but the id has not stopped being a key prefix, so the character set stays as
 *  it was. Both arguments are injectable so tests can assert ordering without
 *  sleeping. */
export const newJobId = (now: number = Date.now(), rand: Buffer = randomBytes(6)): string =>
  `j-${now.toString(36).padStart(9, "0")}-${rand.toString("hex")}`;
