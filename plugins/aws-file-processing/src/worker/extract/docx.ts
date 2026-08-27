import yauzl from "yauzl";
import type { ZipFile } from "yauzl";
import sax from "sax";
import type { PageText } from "../chunk.js";

/** Defensive backstop only. Every real completion path below (new text, a
 *  paragraph break, the parser finishing, or any of the failure paths) calls
 *  notify() itself, so the generator never normally waits this long — a
 *  healthy extraction wakes on the next microtask, not on a timer. If some
 *  path this code (and its stress-testing) did not anticipate goes quiet
 *  without signalling, this converts what would otherwise be a permanent
 *  hang into a bounded, loud failure instead of a wedged worker. */
const WAKE_TIMEOUT_MS = 30_000;

/** DOCX genuinely streams: it is a zip, so word/document.xml is unzipped and
 *  SAX-parsed without materialising the document. Word has no page concept in
 *  the XML — pagination is a rendering decision — so every slice is page 1. */
export async function* extractDocx(path: string): AsyncGenerator<PageText> {
  const queue: string[] = [];
  let done = false;
  let failure: Error | null = null;
  // The open ZipFile, so the drain loop's `finally` below can close it on
  // every exit path — normal completion, a thrown failure, or the caller
  // abandoning the generator early. `close()` unrefs the fd-slicer that holds
  // the underlying `fs.open()` fd; without it that fd is never released
  // (yauzl's own `end` event, which used to be the only place close() was
  // ever considered, never fires here — see below), and a temp file deleted
  // while the fd is still open keeps its disk space too. `close()` is
  // idempotent (yauzl checks `isOpen`), so it is safe to reach from more than
  // one place.
  let zip: ZipFile | null = null;
  // Set the instant the target entry is seen, so a walk that reaches the end
  // of the archive without ever matching it (a corrupted or non-Word zip)
  // can be told apart from one that matched and is still streaming.
  let sawTargetEntry = false;

  // Resolve-on-push rather than a fixed poll: `wake`, when set, is the
  // resolver of the promise the drain loop below is currently awaiting.
  // notify() is called by every event that could make the loop's condition
  // true again, so the loop is woken the instant there is something to check
  // rather than up to a poll interval late. It is level-triggered — the loop
  // always re-reads `queue`/`done`/`failure` fresh after waking — so a
  // notify() that arrives while nothing is being awaited (wake === null) is a
  // harmless no-op: the next iteration's own checks already account for it.
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };

  yauzl.open(path, { lazyEntries: true }, (err, zf) => {
    if (err || !zf) { failure = err ?? new Error("not a zip archive"); done = true; notify(); return; }
    zip = zf;
    zip.on("entry", (entry) => {
      if (entry.fileName !== "word/document.xml") return zip!.readEntry();
      sawTargetEntry = true;
      zip!.openReadStream(entry, (e2, rs) => {
        if (e2 || !rs) { failure = e2 ?? new Error("could not read word/document.xml"); done = true; notify(); return; }
        // A truncated or otherwise corrupted entry — an incomplete DEFLATE
        // stream, or a decompressed byte count that does not match the size
        // recorded in the central directory (yauzl's own AssertByteCountStream
        // check) — surfaces as an 'error' on rs, possibly AFTER pipe() has
        // already forwarded some bytes to the parser. pipe() does not forward
        // a source stream's 'error' to its destination, so without this
        // listener the error is unhandled and Node treats it as fatal,
        // crashing the whole worker over one bad document rather than
        // failing just that document. Verified: halving a real entry's
        // declared compressed size in the central directory reproduces this
        // exact crash on the pre-fix code and a clean rejection here.
        rs.on("error", (e) => { failure = e as Error; done = true; notify(); });
        const parser = sax.createStream(true, {});
        let inText = false;
        parser.on("opentag", (t) => { if (t.name === "w:t") inText = true; });
        parser.on("closetag", (name) => {
          if (name === "w:t") inText = false;
          if (name === "w:p") { queue.push("\n\n"); notify(); }
        });
        parser.on("text", (t) => { if (inText) { queue.push(t); notify(); } });
        // Malformed XML must signal explicitly here: sax does not go on to
        // emit 'end' after 'error', so without done/notify the loop would
        // otherwise sit until the backstop times it out instead of failing
        // fast on a document that is genuinely broken.
        parser.on("error", (e) => { failure = e as Error; done = true; notify(); });
        parser.on("end", () => { done = true; notify(); });
        rs.pipe(parser);
      });
    });
    // Reached only when every central-directory entry has been walked
    // without ever matching word/document.xml — lazyEntries stops calling
    // readEntry() the moment the target is found (see above), so a genuine
    // match never lets this fire. A DOCX that is a valid zip but not a real
    // Word document (or one missing its main part) must not be allowed to
    // complete as an empty, "succeeded" extraction: writeArtifacts would
    // write a 0-chunk chunks.jsonl and the job would report success on a
    // document that was never actually read.
    zip.on("end", () => {
      if (!done) {
        if (!sawTargetEntry) {
          failure = new Error("word/document.xml not found: not a valid DOCX archive");
        }
        done = true;
        notify();
      }
    });
    zip.on("error", (e) => { failure = e as Error; done = true; notify(); });
    zip.readEntry();
  });

  try {
    // Drain as the parser produces, so a large document does not accumulate.
    while (!done || queue.length) {
      if (failure) throw failure;
      if (!queue.length) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            // Reaching here means nothing signalled for WAKE_TIMEOUT_MS, which
            // none of the paths above should allow. Fail loudly with a clear
            // cause rather than silently re-arming another 30 s wait.
            failure = failure ?? new Error(
              `DOCX extraction stalled: no progress for ${WAKE_TIMEOUT_MS}ms`);
            done = true;
            resolve();
          }, WAKE_TIMEOUT_MS);
          timer.unref?.();
          wake = () => { clearTimeout(timer); resolve(); };
        });
        continue;
      }
      const text = queue.splice(0, queue.length).join("");
      if (text) yield { page: 1, text };
    }
    if (failure) throw failure;
  } finally {
    // Runs on every way out of the loop above — normal completion, a thrown
    // failure, or the caller abandoning the generator early (e.g. a `break`
    // out of a `for await` on the consuming side) — because a `finally`
    // wrapping a `yield` is exactly what an async generator's own `.return()`
    // protocol drives on early exit. One close call regardless of how many
    // of the paths above already fired: yauzl's `close()` is a no-op once
    // the zip is already closed.
    //
    // The cast is load-bearing, not decoration: `zip` is only ever assigned
    // inside the yauzl.open() callback above, and TypeScript's control-flow
    // narrowing does not widen a captured `let` back to its declared type
    // after a call that might have run that callback — it keeps narrowing
    // from the `= null` initializer, so `zip?.close()` unadorned resolves to
    // `never` here and fails to typecheck even though this is exactly the
    // case where `zip` is very possibly non-null.
    (zip as ZipFile | null)?.close();
  }
}
