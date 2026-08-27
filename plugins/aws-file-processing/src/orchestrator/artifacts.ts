import type { Readable } from "node:stream";
import { ARTIFACTS } from "../shared/config.js";
import {
  getObjectBuffer, getObjectStream, headObject, isNotFound, type Storage,
} from "../shared/storage.js";

const keyFor = (jobId: string, name: string) => `${jobId}/${name}`;

export const readArtifactJson = async <T>(
  s: Storage, jobId: string, name: string,
): Promise<T> => {
  try {
    return JSON.parse(
      (await getObjectBuffer(s, s.bucket(ARTIFACTS), keyFor(jobId, name))).toString("utf8"),
    ) as T;
  } catch (e: any) {
    if (isNotFound(e)) throw new Error(`artifact ${name} not found for job ${jobId}`);
    throw e;
  }
};

/** A RANGED read: only the requested bytes leave storage. This is what keeps
 *  fetch_chunks constant-cost against a 100 MB chunk file. */
export const readArtifactRange = async (
  s: Storage, jobId: string, name: string, offset: number, count: number,
): Promise<string> =>
  (await getObjectBuffer(s, s.bucket(ARTIFACTS), keyFor(jobId, name), { offset, count }))
    .toString("utf8");

export const artifactStream = async (
  s: Storage, jobId: string, name: string,
): Promise<Readable> => getObjectStream(s, s.bucket(ARTIFACTS), keyFor(jobId, name));

/** A HEAD-style read — never a download — so asking every artifact's size
 *  (spec §6.4's `bytes` field on get_result) stays cheap even for a
 *  chunks.jsonl running into the hundreds of megabytes.
 *
 *  Null, not a throw, when the object is absent. `document.md` was added after
 *  jobs had already been processed, so every job older than it has four
 *  artifacts where the list now names five — and a missing artifact must read
 *  as "this job has no markdown", not as get_result failing outright on a job
 *  whose chunks are perfectly good. */
export const artifactBytes = async (
  s: Storage, jobId: string, name: string,
): Promise<number | null> => {
  try {
    return (await headObject(s, s.bucket(ARTIFACTS), keyFor(jobId, name))).contentLength;
  } catch (e: any) {
    if (isNotFound(e)) return null;
    throw e;
  }
};
