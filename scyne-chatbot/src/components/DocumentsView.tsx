import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Image as ImageIcon, AlertTriangle, RefreshCw, Trash2, Upload } from "lucide-react";
import {
  listDocuments, deleteDocument, replaceDocument, rerunStage, canRerun,
  type DocumentEntry, type DocumentsResult, type StaleArtefact,
} from "../api";
import { OpsState, ago } from "./OpsState";

/**
 * Every document the pipeline will read, and what removing or replacing one
 * makes out of date.
 *
 * Until this existed there was upload and nothing else: no way to see what a
 * project actually held, no way to correct a document that went to the wrong
 * feature, and no way to remove one — so a superseded policy stayed an input to
 * every stage for good, and the only remedy was the filesystem.
 *
 * The staleness banner is the other half, and it is deliberately INERT until
 * clicked. A document change can invalidate five artefacts and an hour of agent
 * time; the tab says which, and a person decides.
 */

const KIND_LABEL: Record<DocumentEntry["kind"], string> = {
  markdown: "markdown",
  image: "image",
  audio: "audio",
  unconverted: "not converted",
  other: "other",
};

const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export function DocumentsView({
  project, feature, onRunStarted,
}: {
  project: string | null;
  feature: string | null;
  /** A re-run creates an issue; Chat is where its Activity panel lives. */
  onRunStarted: (issueId: string) => void;
}) {
  const [data, setData] = useState<DocumentsResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Which document a chosen file is meant to replace. One hidden input for the
  // whole table, retargeted per row — a file input per row would be dozens.
  const replacing = useRef<DocumentEntry | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!project) { setData(null); return; }
    try {
      const r = await listDocuments(project, feature);
      setData(r);
      setError(null);
      // Everything stale is checked by default. The person opened this because
      // they changed a document; the question is which refreshes to SKIP.
      setSelected(new Set(r.stale.filter(s => canRerun(s.key)).map(s => s.key)));
    } catch (e) {
      setError(e);
      setData(null);
    }
  }, [project, feature]);

  useEffect(() => { load(); }, [load]);

  const all = useMemo(
    () => [...(data?.documents.project ?? []), ...(data?.documents.feature ?? [])],
    [data]);

  async function remove(doc: DocumentEntry) {
    const where = doc.level === "feature" ? `${project} / ${doc.feature}` : project;
    if (!window.confirm(
      `Delete ${doc.name} from ${where}?\n\n` +
      (doc.original ? `The archived original (${doc.original.split("/").pop()}) goes with it.\n\n` : "") +
      `Every stage that reads it will be flagged out of date.`)) return;

    setBusy(doc.path); setNote(null);
    try {
      const r = await deleteDocument(project!, doc.feature, doc.path);
      setNote(`Deleted ${r.removed.length === 2 ? `${doc.name} and its archived original` : doc.name}.`);
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function pickReplacement(doc: DocumentEntry) {
    replacing.current = doc;
    filePicker.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const doc = replacing.current;
    // Reset immediately: choosing the same file twice in a row fires no change
    // event otherwise, so a failed replace could not be retried.
    e.target.value = "";
    replacing.current = null;
    if (!file || !doc || !project) return;

    setBusy(doc.path); setNote(null);
    try {
      const r = await replaceDocument(project, doc.feature, doc.path, file);
      setNote(
        `Replaced ${doc.name} with ${r.filename}` +
        (r.converted ? " (converted to markdown)." : "."));
      await load();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const runnable = (data?.stale ?? []).filter(s => canRerun(s.key));
  const chosen = runnable.filter(s => selected.has(s.key));

  async function rerunSelected() {
    if (!project || !chosen.length) return;
    setBusy("rerun"); setNote(null);
    const started: string[] = [];
    const failed: string[] = [];
    // Sequential, in pipeline order, because a later stage reads an earlier
    // one's output — firing them together would have the data model read a
    // product summary that is being rewritten as it reads it.
    for (const s of chosen) {
      try {
        const issue = await rerunStage(s.key, project, feature);
        started.push(s.label ?? s.key);
        if (issue?.issueId || issue?.id) onRunStarted(issue.issueId ?? issue.id);
      } catch (e) {
        failed.push(`${s.label ?? s.key} (${(e as Error).message})`);
      }
    }
    setNote(
      [started.length ? `Started: ${started.join(", ")}.` : "",
       failed.length ? `Could not start: ${failed.join("; ")}.` : ""].filter(Boolean).join(" "));
    setBusy(null);
    await load();
  }

  if (!project) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-scyne-ink">Documents</h1>
        <p className="text-sm text-scyne-ink/60">Pick a project in Chat to see its documents.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <input
        ref={filePicker}
        type="file"
        className="sr-only"
        onChange={onFileChosen}
        aria-hidden
        tabIndex={-1}
      />

      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-scyne-ink">Documents</h1>
          <p className="text-sm text-scyne-ink/60">
            {data
              ? `${project}${feature ? ` › ${feature}` : ""} · ${all.length} ${all.length === 1 ? "document" : "documents"}`
              : " "}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="rounded-full border border-scyne-line px-3 py-1 text-xs font-medium text-scyne-ink/70 hover:border-scyne-ink hover:text-scyne-ink"
        >
          Refresh
        </button>
      </header>

      {note && (
        <p role="status" className="rounded-lg border border-scyne-line bg-scyne-ink-50 px-3 py-2 text-sm text-scyne-ink">
          {note}
        </p>
      )}

      <OpsState
        error={error}
        loading={data === null && !error}
        empty={data !== null && all.length === 0}
        emptyLabel={
          feature
            ? `Nothing uploaded to ${project} or ${feature} yet — add documents from Chat.`
            : `Nothing uploaded to ${project} yet — add documents from Chat.`
        }
      />

      {data && data.documents.project.length > 0 && (
        <DocumentTable
          title="Project"
          caption={`Client-wide material. Every feature and every skill reads these.`}
          docs={data.documents.project}
          busy={busy}
          onReplace={pickReplacement}
          onDelete={remove}
        />
      )}

      {data && feature && (
        <DocumentTable
          title={`Feature · ${feature}`}
          caption="Discovery material for this slice of work only."
          docs={data.documents.feature}
          busy={busy}
          onReplace={pickReplacement}
          onDelete={remove}
          emptyLabel={`No discovery documents under ${feature} yet.`}
        />
      )}

      {data && data.stale.length > 0 && (
        <StalenessPanel
          stale={data.stale}
          selected={selected}
          onToggle={(key) => setSelected(prev => {
            const next = new Set(prev);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
          })}
          onRun={rerunSelected}
          running={busy === "rerun"}
          chosenCount={chosen.length}
        />
      )}
    </div>
  );
}

function DocumentTable({
  title, caption, docs, busy, onReplace, onDelete, emptyLabel,
}: {
  title: string;
  caption: string;
  docs: DocumentEntry[];
  busy: string | null;
  onReplace: (d: DocumentEntry) => void;
  onDelete: (d: DocumentEntry) => void;
  emptyLabel?: string;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-scyne-ink/50">{title}</h2>
        <span className="text-xs text-scyne-ink/50">{docs.length}</span>
      </div>

      {docs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-scyne-line px-3 py-4 text-sm text-scyne-ink/50">
          {emptyLabel ?? "Nothing here."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-scyne-line bg-white">
          <table className="w-full text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-scyne-ink/50">
                <th scope="col" className="px-3 py-2 font-semibold">Document</th>
                <th scope="col" className="px-3 py-2 font-semibold">Folder</th>
                <th scope="col" className="px-3 py-2 font-semibold">Size</th>
                <th scope="col" className="px-3 py-2 font-semibold">Changed</th>
                <th scope="col" className="px-3 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.path} className="border-t border-scyne-line">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      {d.kind === "image"
                        ? <ImageIcon className="size-4 shrink-0 text-scyne-ink/40" aria-hidden />
                        : <FileText className="size-4 shrink-0 text-scyne-ink/40" aria-hidden />}
                      <span className="font-medium text-scyne-ink">{d.name}</span>
                    </span>
                    {/* What a person recognises is the file they uploaded. The
                        converter replaced it, so the row would otherwise name
                        something they have never seen. */}
                    {d.original && (
                      <span className="ml-6 block text-[11px] text-scyne-ink/50">
                        from {d.original.split("/").pop()}
                      </span>
                    )}
                    {d.kind === "unconverted" && (
                      <span className="ml-6 flex items-center gap-1 text-[11px] text-amber-700">
                        <AlertTriangle className="size-3" aria-hidden />
                        not converted — no stage can read this yet
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-scyne-ink/70">{d.subfolder}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-scyne-ink/60">{bytes(d.bytes)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-scyne-ink/60">{ago(d.modifiedAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <button
                      type="button"
                      onClick={() => onReplace(d)}
                      disabled={busy !== null}
                      aria-label={`Replace ${d.name}`}
                      title="Replace with a new file"
                      className="rounded p-1.5 text-scyne-ink/60 hover:bg-scyne-line/60 hover:text-scyne-ink disabled:opacity-40"
                    >
                      <Upload className="size-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(d)}
                      disabled={busy !== null}
                      aria-label={`Delete ${d.name}`}
                      title="Delete, with its archived original"
                      className="rounded p-1.5 text-scyne-ink/60 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <span className="sr-only">{caption}</span>
    </section>
  );
}

function StalenessPanel({
  stale, selected, onToggle, onRun, running, chosenCount,
}: {
  stale: StaleArtefact[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  onRun: () => void;
  running: boolean;
  chosenCount: number;
}) {
  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50/60 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden />
        <div>
          <h2 className="text-sm font-semibold text-amber-900">
            {stale.length} {stale.length === 1 ? "artefact predates" : "artefacts predate"} their inputs
          </h2>
          <p className="text-xs text-amber-900/80">
            Generated before a document they read last changed. Nothing re-runs until you say so — each
            one is a full agent run.
          </p>
        </div>
      </div>

      <ul className="space-y-1.5">
        {stale.map((s) => {
          const runnable = canRerun(s.key);
          return (
            <li key={s.key}>
              <label className={`flex items-start gap-2 text-sm ${runnable ? "" : "opacity-60"}`}>
                <input
                  type="checkbox"
                  checked={selected.has(s.key)}
                  onChange={() => onToggle(s.key)}
                  disabled={!runnable || running}
                  className="mt-1 size-3.5 accent-amber-700"
                />
                <span>
                  <span className="font-medium text-amber-950">{s.label ?? s.key}</span>
                  <span className="text-amber-900/70">
                    {" "}— superseded by {s.supersededBy.map(b => b.label).join(", ")}
                  </span>
                  {!runnable && (
                    <span className="block text-[11px] text-amber-900/60">
                      no trigger for this stage — run it from Chat
                    </span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={onRun}
        disabled={running || chosenCount === 0}
        className="inline-flex items-center gap-2 rounded-lg bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50"
      >
        <RefreshCw className={`size-4 ${running ? "animate-spin" : ""}`} aria-hidden />
        {running ? "Starting…" : `Re-run ${chosenCount} selected`}
      </button>
    </section>
  );
}
