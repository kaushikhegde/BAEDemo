import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, AlertTriangle } from "lucide-react";
import { extractLog, retryExtraction, type ExtractLog, type DocumentEntry } from "../api";
import { ago } from "./OpsState";

/**
 * Why one document's extraction failed, and what the agent actually did.
 *
 * Two halves, because they answer different questions:
 *
 * - The RECORD — the reason, how many times, over what period. `attempts` is
 *   the field somebody makes a decision on: a document that failed the same way
 *   twice will not extract and needs replacing, not retrying, and until this
 *   existed the only way to see it was to open `.extract.failed.json` by hand.
 * - The TRANSCRIPT — what the agent did with the document. Extraction is a
 *   fan-out inside one `exec` step, so this is the only place a single
 *   document's run is reachable; the console shows the whole step's runs and
 *   leaves you to find the row.
 *
 * Either can be absent and both absences are ordinary: a document uploaded a
 * minute ago has no run, and one that has never failed has no record.
 */
export function ExtractLogDialog({
  doc, project, onClose, onRetried,
}: {
  /** The document whose log to show. `null` closes the dialog. */
  doc: DocumentEntry | null;
  project: string;
  onClose: () => void;
  /** So the tab can re-poll — a retry changes state the list is showing. */
  onRetried: () => void;
}) {
  const [log, setLog] = useState<ExtractLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!doc) { setLog(null); setError(null); return; }
    let cancelled = false;
    setLog(null); setError(null);
    extractLog(project, doc.feature, doc.path)
      .then((l) => { if (!cancelled) setLog(l); })
      .catch((e) => { if (!cancelled) setError(e?.message ?? String(e)); });
    return () => { cancelled = true; };
  }, [doc, project]);

  const retry = async () => {
    if (!doc) return;
    setRetrying(true);
    try {
      // Scoped by SCOPE as well as path: two features can hold the same
      // `requirements/SOP/Onboarding.md`, and `--doc` accepts either form.
      await retryExtraction(project, {
        doc: doc.feature ? `${doc.feature}/${doc.path}` : doc.path,
        // A document that is already `ready` cannot differ on a re-run — its
        // extract is keyed to content that has not changed — so the server
        // refuses without this. Asked for explicitly here because the button
        // only appears on one that is not ready.
        force: doc.extract?.state === "ready",
      });
      onRetried();
      onClose();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRetrying(false);
    }
  };

  const record = log?.record;

  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="break-words">{doc?.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {doc?.path}
            {log?.run && <> · {log.run.issue} · {log.run.status}</>}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        {!log && !error && <Skeleton className="h-32 w-full" />}

        {log && (
          <div className="space-y-4">
            {record?.state === "failed" && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                <p className="flex items-center gap-1.5 text-sm font-medium text-red-800">
                  <AlertTriangle className="size-4" aria-hidden />
                  Failed {record.attempts ?? 1} time{record.attempts === 1 ? "" : "s"}
                </p>
                {record.reason && (
                  <p className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-red-900/80">
                    {record.reason}
                  </p>
                )}
                {record.lastFailedAt && (
                  <p className="mt-2 text-[11px] text-red-800/70">
                    Last {ago(record.lastFailedAt)}
                    {record.firstFailedAt && record.firstFailedAt !== record.lastFailedAt
                      ? `, first ${ago(record.firstFailedAt)}` : ""}
                  </p>
                )}
                {/* The line that decides retry-or-replace. Twice the same way is
                    not weather — it is a document this pipeline cannot read. */}
                {(record.attempts ?? 0) >= 2 && (
                  <p className="mt-2 text-[11px] font-medium text-red-800">
                    It has failed more than once. If the reason is the same each time, replace the
                    document rather than retrying — a scanned PDF with no text layer never extracts.
                  </p>
                )}
              </div>
            )}

            {record && record.state !== "failed" && (
              <p className="text-sm text-scyne-ink/70">
                {record.state === "ready" ? "Extracted."
                  : record.state === "extracting" ? "Extracting now."
                  : "Not extracted yet — nothing has failed."}
              </p>
            )}

            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-scyne-ink/50">
                Run transcript
              </p>
              {!log.run ? (
                // Not an error. A document uploaded a minute ago has no run,
                // and saying so beats an empty box that reads as a fault.
                <p className="rounded-md border border-scyne-line px-3 py-2 text-sm text-scyne-ink/50">
                  No extraction has run for this document yet.
                </p>
              ) : log.events.length === 0 ? (
                <p className="rounded-md border border-scyne-line px-3 py-2 text-sm text-scyne-ink/50">
                  The run left no transcript.
                </p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-md border border-scyne-line bg-scyne-line/20 p-2">
                  {log.events.map((e, i) => (
                    <p key={i} className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-scyne-ink/75">
                      {[e.tool, e.text ?? e.detail].filter(Boolean).join(" ") || JSON.stringify(e)}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={retry}
              disabled={retrying}
              className="flex items-center gap-1.5 rounded-full border border-scyne-line px-3 py-1.5 text-xs font-medium text-scyne-ink transition-colors hover:border-scyne-ink disabled:opacity-50"
            >
              <RefreshCw className={`size-3.5 ${retrying ? "animate-spin" : ""}`} aria-hidden />
              {retrying ? "Starting…" : "Retry this document"}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
