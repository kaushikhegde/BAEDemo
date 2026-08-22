import { useEffect, useState, lazy, Suspense } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { readDocument, type DocumentContent, type DocumentEntry } from "../api";
import { stripConverterBanner } from "@/lib/markdown";

/**
 * One document, read.
 *
 * The whole point of converting everything to markdown is that a person can
 * check what the agents will actually read — and until this existed there was
 * nowhere to do it. The approval card renders GENERATED artefacts; the client's
 * own SOP, the transcript a story was traced to, the policy a capability map
 * cites, could only be opened from a filesystem.
 *
 * `Markdown` is lazy for the same reason ArtifactsPreview loads it that way: it
 * pulls in react-markdown, remark-gfm and mermaid, which is most of a megabyte
 * nobody browsing a file list has asked for yet.
 */
const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export function DocumentPreview({
  doc, project, onClose,
}: {
  /** The document to show. `null` closes the dialog. */
  doc: DocumentEntry | null;
  project: string;
  onClose: () => void;
}) {
  const [file, setFile] = useState<DocumentContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    if (!doc) { setFile(null); setError(null); return; }
    let cancelled = false;
    setFile(null);
    setError(null);
    setRaw(false);      // every document opens rendered
    readDocument(project, doc.feature, doc.path)
      .then((r) => { if (!cancelled) setFile(r); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [doc, project]);

  // Machine-generated markdown keeps its line structure; a person's does not.
  // markitdown-ts flattens a PDF table to one field per line with no blank
  // lines, and CommonMark joins those into a single run-on paragraph — so a
  // document that read perfectly well as a PDF arrived here as a wall of text.
  const converted = Boolean(file?.convertedFrom);
  const body = file ? stripConverterBanner(file.content) : "";

  return (
    <Dialog open={Boolean(doc)} onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* Wider and taller than the default: these run to tens of thousands of
          words, and a document the reader has to scroll in a 400px box is one
          they will not read. */}
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="break-all">{doc?.name}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-[11px]">{doc?.path}</span>
            {doc && (
              <>
                {" · "}{bytes(doc.bytes)}
                {/* What a person recognises is the file they uploaded, which
                    the converter replaced. The banner names it exactly; the
                    archived upload is the fallback. */}
                {(file?.convertedFrom || doc.original) && (
                  <> · converted from {file?.convertedFrom ?? doc.original!.split("/").pop()}</>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {file && (
          <div className="mb-2 flex items-center justify-end">
            {/* The escape hatch. A converted document can be mangled in ways no
                renderer can undo, and the file is the only thing that is
                definitely true — so it is always one click away. */}
            <span className="inline-flex overflow-hidden rounded-full border border-scyne-line" role="group" aria-label="View">
              {([["rendered", false], ["source", true]] as const).map(([label, v]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setRaw(v)}
                  aria-pressed={raw === v}
                  className={[
                    "px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                    raw === v ? "bg-scyne-ink text-white" : "text-scyne-ink/70 hover:bg-scyne-line/60",
                  ].join(" ")}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
        )}

        <div className="max-h-[70vh] overflow-y-auto pr-1">
          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
          )}
          {!error && file === null && (
            <div className="space-y-2 py-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          )}
          {file !== null && (
            !file.content.trim()
              // An empty file is a real state and a common one — a conversion
              // that produced nothing. Saying so beats an empty pane.
              ? <p className="py-6 text-center text-sm italic text-slate-500">This document is empty.</p>
              : raw
                // The file verbatim, banner included — `source` means source.
                ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-slate-700">
                    {file.content}
                  </pre>
                )
                : (
                  <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                    <Markdown source={body} preserveLineBreaks={converted} />
                  </Suspense>
                )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
