import { ARTIFACTS_CONTAINER } from "../shared/config.js";
import type { Storage } from "../shared/storage.js";

const blob = (s: Storage, jobId: string, name: string) =>
  s.blob.getContainerClient(ARTIFACTS_CONTAINER).getBlockBlobClient(`${jobId}/${name}`);

export const readArtifactJson = async <T>(
  s: Storage, jobId: string, name: string,
): Promise<T> => {
  try {
    return JSON.parse((await blob(s, jobId, name).downloadToBuffer()).toString("utf8")) as T;
  } catch (e: any) {
    if (e?.statusCode === 404) throw new Error(`artifact ${name} not found for job ${jobId}`);
    throw e;
  }
};

/** A RANGED read: only the requested bytes leave storage. This is what keeps
 *  fetch_chunks constant-cost against a 100 MB chunk file. */
export const readArtifactRange = async (
  s: Storage, jobId: string, name: string, offset: number, count: number,
): Promise<string> =>
  (await blob(s, jobId, name).downloadToBuffer(offset, count)).toString("utf8");

export const artifactStream = async (s: Storage, jobId: string, name: string) => {
  const dl = await blob(s, jobId, name).download();
  if (!dl.readableStreamBody) throw new Error(`artifact ${name} returned no body`);
  return dl.readableStreamBody;
};

/** A HEAD-style properties read — never a download — so asking every
 *  artifact's size (spec §6.4's `bytes` field on get_result) stays cheap even
 *  for a chunks.jsonl running into the hundreds of megabytes.
 *
 *  Null, not a throw, when the blob is absent. `document.md` was added after
 *  jobs had already been processed, so every job older than it has four
 *  artifacts where the list now names five — and a missing artifact must read
 *  as "this job has no markdown", not as get_result failing outright on a job
 *  whose chunks are perfectly good. */
export const artifactBytes = async (
  s: Storage, jobId: string, name: string,
): Promise<number | null> => {
  try {
    const props = await blob(s, jobId, name).getProperties();
    return props.contentLength ?? 0;
  } catch (e: any) {
    if (e?.statusCode === 404) return null;
    throw e;
  }
};
