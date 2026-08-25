import { randomBytes } from "node:crypto";

/** Sortable by creation time, and free of every character Azure Table Storage
 *  rejects in a RowKey (`/ \ # ?`). Both arguments are injectable so tests can
 *  assert ordering without sleeping. */
export const newJobId = (now: number = Date.now(), rand: Buffer = randomBytes(6)): string =>
  `j-${now.toString(36).padStart(9, "0")}-${rand.toString("hex")}`;
