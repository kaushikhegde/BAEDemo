import multer from "multer";
import type { RequestHandler } from "express";
import { carryAuth } from "./auth.js";

/**
 * No size limit.
 *
 * There was one — 100 MB, in `multer.memoryStorage()` — because content
 * travelled through this process's memory and then base64 through a JSON body
 * to reach the database. Three ceilings sat behind it: 100 MB here, ~384 MB
 * from V8's cap on a base64 string, and 1 GB from Postgres `bytea`. Bytes go
 * to object storage now, addressed by their own hash, so all three are gone
 * rather than raised — raising them would only have moved the failure, since
 * two of the three were never ours to move.
 */
const upload = multer({ storage: multer.memoryStorage() });

/**
 * One file from a multipart body, with the request's credential carried back.
 *
 * multer parses the body in busboy's stream callbacks, which run outside the
 * AsyncLocalStorage context `carryAuth` opened for the request, so a route
 * behind bare `upload.single()` saw no credential at all. Its own writes still
 * worked — they pass `tokenFor(req)` explicitly — but every
 * `orchestrator.call()` it made went out unauthenticated. The one that
 * mattered was `startExtraction`: refused with a 401 that was only logged, so
 * documents uploaded through the project wizard were never read and Deploy
 * waited on them for ever. Re-entering `carryAuth` after multer restores it.
 */
export function fileUpload(field: string): RequestHandler {
  const parse = upload.single(field);
  return (req, res, next) => parse(req, res, (err?: unknown) => (err ? next(err) : carryAuth(req, res, next)));
}
