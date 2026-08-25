import { createReadStream } from "node:fs";
import type { PageText } from "../chunk.js";

/** Plain text has no pages. It is emitted in fixed slices so the chunker still
 *  receives it incrementally rather than as one enormous string, and every
 *  slice reports page 1. */
export async function* extractText(path: string): AsyncGenerator<PageText> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
  for await (const slice of stream) yield { page: 1, text: slice as string };
}
