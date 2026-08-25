export interface PageText { page: number; text: string }

export interface Chunk {
  chunkId: string;
  pageStart: number;   // the page the chunk's FIRST character came from
  pageEnd: number;     // the page the chunk's LAST character came from
  charStart: number;   // global character offset in the extracted document
  charEnd: number;
  text: string;
}

export const chunkIdFor = (n: number): string => `c-${String(n).padStart(6, "0")}`;

/** Where to cut a buffer that has reached the window size. Paragraph, then line,
 *  then sentence, then a hard cut — a hard cut only when the window contains no
 *  boundary at all, which is what makes the output stable for any input. */
const splitPoint = (buf: string, limit: number): number => {
  const window = buf.slice(0, limit);
  const floor = Math.floor(limit * 0.5); // never cut so early the chunk is tiny
  for (const sep of ["\n\n", "\n", ". "]) {
    const at = window.lastIndexOf(sep);
    if (at >= floor) return at + sep.length;
  }
  return limit;
};

/** Async because extraction yields pages over time (a PDF window at a time).
 *  `for await` consumes a plain array just as happily, so callers with all the
 *  pages in hand pass one directly. */
export async function* chunkPages(
  pages: AsyncIterable<PageText> | Iterable<PageText>,
  opts: { chunkChars: number; overlapChars: number },
): AsyncGenerator<Chunk> {
  const { chunkChars, overlapChars } = opts;
  if (chunkChars <= 0) throw new Error("chunkChars must be positive");
  const maxOverlap = Math.floor(chunkChars / 2);
  if (overlapChars < 0 || overlapChars > maxOverlap) {
    throw new Error(`overlapChars must be in [0, ${maxOverlap}]; got ${overlapChars}`);
  }

  // Page boundaries as global offsets, so a chunk's page is looked up exactly
  // rather than approximated from whichever page happened to be in flight.
  const marks: Array<{ at: number; page: number }> = [];
  const pageAt = (offset: number): number => {
    let page = marks.length ? marks[0].page : 1;
    for (const m of marks) { if (m.at <= offset) page = m.page; else break; }
    return page;
  };

  let buf = "";
  let bufStart = 0;   // global offset of buf[0]
  let consumed = 0;   // global offset just past the end of buf
  let n = 0;

  const flush = function* (limit: number): Generator<Chunk> {
    while (buf.length >= limit) {
      const cut = splitPoint(buf, chunkChars);
      const text = buf.slice(0, cut);
      // Computed here, before bufStart advances and marks are pruned below:
      // pageEnd looks up the chunk's LAST character (bufStart + cut - 1), and
      // the marks this chunk's own span depends on are still intact at this
      // point — the prune below only ever removes marks strictly behind the
      // NEW bufStart, never behind this chunk's own charEnd.
      const pageStart = pageAt(bufStart);
      const pageEnd = pageAt(bufStart + cut - 1);
      yield {
        chunkId: chunkIdFor(n++), pageStart, pageEnd,
        charStart: bufStart, charEnd: bufStart + cut, text,
      };
      // Use cut - 1 to guarantee forward progress: ensures bufStart advances by ≥1 even if
      // cut is tiny due to a boundary near splitPoint's floor. Currently unreachable (validation
      // above rejects overlapChars > floor), but defence in depth — must be preserved if
      // validation bounds are ever widened.
      const keep = Math.min(overlapChars, cut - 1);
      buf = buf.slice(cut - keep);
      bufStart += cut - keep;
      while (marks.length > 1 && marks[1].at <= bufStart) marks.shift();
    }
  };

  for await (const p of pages as AsyncIterable<PageText>) {
    marks.push({ at: consumed, page: p.page });
    buf += p.text;
    consumed += p.text.length;
    yield* flush(chunkChars);
  }

  if (buf.trim().length > 0) {
    yield {
      chunkId: chunkIdFor(n++), pageStart: pageAt(bufStart), pageEnd: pageAt(bufStart + buf.length - 1),
      charStart: bufStart, charEnd: bufStart + buf.length, text: buf,
    };
  }
}
