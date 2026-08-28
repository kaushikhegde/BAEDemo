import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, LayoutGrid, Rows3, Search, Check, X, Loader2 } from "lucide-react";
import {
  listDocuments, deleteDocument, replaceDocument, uploadFile, uploadProjectFile,
  rerunStage, canRerun, retryExtraction,
  type DocumentEntry, type DocumentsResult, type StaleArtefact, type UploadHint,
} from "../api";
import { OpsState, FilterSelect, ClearFilters } from "./OpsState";
import { TargetPicker } from "./TargetPicker";
import { DocumentFolder, type FolderSpec } from "./DocumentFolder";
import { DocumentPreview } from "./DocumentPreview";
import { ExtractLogDialog } from "./ExtractLogDialog";
import { DOC_ACCEPT, AUDIO_ACCEPT, IMAGE_ACCEPT } from "../lib/uploadFormats";

/**
 * Every document the pipeline will read, in the folders it reads them from.
 *
 * Until this existed there was upload and nothing else: no way to see what a
 * project held, no way to correct a document that went to the wrong feature,
 * and no way to remove one — so a superseded policy stayed an input to every
 * stage for good, and the only remedy was the filesystem.
 *
 * Three things this screen has to get right, and they are all about the folder:
 * the BA treats Transcripts/ (the primary source of stories) differently from
 * SOP/ (context, explicitly not stories), the UX Designer treats
 * requirements/UI/ as authoritative, and a stage refusing with "no documents"
 * is nearly always one of these folders being empty. So documents are grouped
 * by folder rather than listed flat with a folder column, empty folders are
 * shown, and a drop targets a folder by name.
 *
 * Dropping on a NAMED folder also sidesteps the one refusal the chat attach
 * button cannot: `routeFile` returns `ambiguous` only when no hint was
 * supplied, and a folder is a hint.
 */

const ALL = "";
const VIEW_KEY = "scyne_docs_view";

/** What each folder accepts — the same list the chat attach button uses. */

/** The four discovery folders, in the order stage.mjs reports them. */
const FEATURE_FOLDERS: Array<{ dir: string; hint: UploadHint & FolderSpec["hint"]; accept: string; blurb: string }> = [
  { dir: "SOP", hint: "sop", accept: DOC_ACCEPT, blurb: "SOP & policy documents" },
  { dir: "Transcripts", hint: "transcripts", accept: `${DOC_ACCEPT},${AUDIO_ACCEPT}`, blurb: "meetings — documents or audio" },
  { dir: "Notes", hint: "notes", accept: DOC_ACCEPT, blurb: "anything else" },
  { dir: "UI", hint: "ui", accept: IMAGE_ACCEPT, blurb: "client-supplied screens" },
];

/** One file's trip through upload and conversion. */
interface QueueItem {
  id: string;
  name: string;
  folder: string;
  state: "queued" | "working" | "done" | "failed";
  detail?: string;
}

export function DocumentsView({
  project, feature, onTargetChange, onRunStarted, refreshKey,
}: {
  project: string | null;
  feature: string | null;
  /** The tab pins its own target — you cannot upload to SOP/ without a feature. */
  onTargetChange: (project: string | null, feature: string | null) => void;
  /** A re-run creates an issue; Chat is where its Activity panel lives. */
  onRunStarted: (issueId: string) => void;
  refreshKey?: number;
}) {
  const [data, setData] = useState<DocumentsResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [preview, setPreview] = useState<DocumentEntry | null>(null);
  const [logFor, setLogFor] = useState<DocumentEntry | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [view, setViewRaw] = useState<"table" | "grid">(() => {
    if (typeof window === "undefined") return "table";
    return window.localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "table";
  });
  const setView = (v: "table" | "grid") => {
    setViewRaw(v);
    try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
  };

  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState(ALL);
  const [kind, setKind] = useState(ALL);
  const [level, setLevel] = useState(ALL);

  // Which document a chosen file is meant to replace. One hidden input for the
  // whole page, retargeted per row — one per document would be dozens.
  const replacing = useRef<DocumentEntry | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!project) { setData(null); return; }
    try {
      // Excerpts are one file read per markdown document server-side, so they
      // are asked for only when there is a card to put them on.
      const r = await listDocuments(project, feature, { excerpts: view === "grid" });
      setData(r);
      setError(null);
      setSelected(new Set(r.stale.filter((s) => canRerun(s.key)).map((s) => s.key)));
    } catch (e) {
      setError(e);
      setData(null);
    }
  }, [project, feature, view]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const folders: FolderSpec[] = useMemo(() => {
    const out: FolderSpec[] = [{
      id: "project:documents",
      label: "Project › documents",
      feature: null,
      hint: null,
      accept: DOC_ACCEPT,
      blurb: "client-wide policy, legislation, standards",
    }];
    if (feature) {
      for (const f of FEATURE_FOLDERS) {
        out.push({
          id: `${feature}:${f.dir}`,
          label: `${feature} › ${f.dir}`,
          feature,
          hint: f.hint,
          accept: f.accept,
          blurb: f.blurb,
        });
      }
    }
    return out;
  }, [feature]);

  const all = useMemo(
    () => [...(data?.documents.project ?? []), ...(data?.documents.feature ?? [])],
    [data]);

  // Options come from the rows actually loaded, as the Issues view does, so a
  // filter can never offer a value that returns nothing.
  const options = useMemo(() => ({
    folders: [...new Set(all.map((d) => d.subfolder))].sort(),
    kinds: [...new Set(all.map((d) => d.kind))].sort(),
    levels: [...new Set(all.map((d) => d.level))].sort(),
  }), [all]);

  /**
   * How many documents are not usable yet.
   *
   * `capabilities` refuses `documents_not_ready` until every one is `ready`, so
   * this number IS "what is stopping the pipeline". `extracting` is excluded —
   * that work is already happening and pressing the button would not add to it.
   */
  const outstanding = useMemo(
    () => all.filter((d) => d.extract && (d.extract.state === "missing" || d.extract.state === "failed")).length,
    [all]);

  const extractOutstanding = async () => {
    if (!project) return;
    setBusy("extract");
    try {
      // No `doc` and no `force`: the server's own retry planner decides what is
      // outstanding, so this cannot disagree with what the badges say.
      await retryExtraction(project);
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const matches = useCallback((d: DocumentEntry) => {
    const q = search.trim().toLowerCase();
    return (!q || d.name.toLowerCase().includes(q) || (d.original ?? "").toLowerCase().includes(q))
      && (!folder || d.subfolder === folder)
      && (!kind || d.kind === kind)
      && (!level || d.level === level);
  }, [search, folder, kind, level]);

  const shown = useMemo(() => all.filter(matches), [all, matches]);
  const activeFilters = [search.trim(), folder, kind, level].filter(Boolean).length;

  const clear = () => { setSearch(""); setFolder(ALL); setKind(ALL); setLevel(ALL); };

  /**
   * Which documents belong to a folder.
   *
   * Matched on the LOWERCASED folder name against the hint, because the two
   * vocabularies differ in case and only in case: `DISK_SUBFOLDER` maps
   * `sop → SOP` and `transcripts → Transcripts`, so upper-casing the hint would
   * match SOP and UI and quietly miss the other two.
   */
  const inFolder = (d: DocumentEntry, spec: FolderSpec) =>
    d.feature === spec.feature && (spec.hint === null || d.subfolder.toLowerCase() === spec.hint);

  // ---------------------------------------------------------------- uploads

  async function upload(spec: FolderSpec, files: File[]) {
    if (!project) return;
    const items: QueueItem[] = files.map((f, i) => ({
      id: `${Date.now()}-${i}-${f.name}`,
      name: f.name,
      folder: spec.label,
      state: "queued",
    }));
    setQueue(items);
    setBusy("upload");
    setNote(null);

    const mark = (id: string, patch: Partial<QueueItem>) =>
      setQueue((q) => q.map((it) => (it.id === id ? { ...it, ...patch } : it)));

    // SEQUENTIAL, as AttachmentButton is. It is slower for a big drop and it is
    // what makes the queue honest: one file is in flight, the rest are waiting,
    // and the screen can say so truthfully.
    for (let i = 0; i < files.length; i++) {
      const item = items[i];
      mark(item.id, { state: "working" });
      try {
        // Upload and conversion happen in ONE request — the route converts on
        // arrival, because every stage's 409 gate counts `.md` and staging runs
        // after that gate. There is no observable boundary between the two, so
        // the queue does not invent one.
        const r = spec.hint === null
          ? await uploadProjectFile(project, files[i])
          : await uploadFile(project, spec.feature!, files[i], spec.hint);

        if ("ambiguous" in r && r.ambiguous) {
          // Unreachable from here — a folder always supplies a hint — but a
          // silent success would be the worst way to find out otherwise.
          mark(item.id, { state: "failed", detail: r.message });
          continue;
        }
        const ok = r as { filename: string; converted: boolean };
        mark(item.id, {
          state: "done",
          detail: ok.converted ? `converted to ${ok.filename}` : ok.filename,
        });
      } catch (e) {
        mark(item.id, { state: "failed", detail: (e as Error).message });
      }
    }

    setBusy(null);
    await load();
  }

  // ------------------------------------------------------- replace / delete

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

  async function onReplacementChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const doc = replacing.current;
    // Reset immediately: choosing the same file twice fires no change event
    // otherwise, so a failed replace could not be retried.
    e.target.value = "";
    replacing.current = null;
    if (!file || !doc || !project) return;

    setBusy(doc.path); setNote(null);
    try {
      const r = await replaceDocument(project, doc.feature, doc.path, file);
      setNote(`Replaced ${doc.name} with ${r.filename}${r.converted ? " (converted to markdown)." : "."}`);
      await load();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // ---------------------------------------------------------------- re-runs

  const runnable = (data?.stale ?? []).filter((s) => canRerun(s.key));
  const chosen = runnable.filter((s) => selected.has(s.key));

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

  // ------------------------------------------------------------------- view

  return (
    <div className="space-y-4">
      <input
        ref={filePicker}
        type="file"
        className="sr-only"
        onChange={onReplacementChosen}
        aria-hidden
        tabIndex={-1}
      />

      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-scyne-ink">Documents</h1>
            <p className="text-sm text-scyne-ink/60">
              {data
                ? activeFilters
                  // Say what was hidden. A count with no denominator is how
                  // somebody concludes an upload never landed.
                  ? `${shown.length} of ${all.length}`
                  : `${all.length} ${all.length === 1 ? "document" : "documents"}`
                : " "}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Pinned here as well as in Chat: you cannot upload to SOP/ without
                a feature, and sending someone back to another screen to choose
                one is how a drop zone comes to look broken. */}
            <TargetPicker project={project} feature={feature} onChange={onTargetChange} />

            <span className="inline-flex overflow-hidden rounded-full border border-scyne-line" role="group" aria-label="Layout">
              {([["table", Rows3, "Table"], ["grid", LayoutGrid, "Grid"]] as const).map(([v, Icon, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={[
                    "flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-colors",
                    view === v ? "bg-scyne-ink text-white" : "text-scyne-ink/70 hover:bg-scyne-line/60",
                  ].join(" ")}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {label}
                </button>
              ))}
            </span>

            {/* Only when there is something to do. A button that starts a
                twenty-minute run and reports "nothing outstanding" is worse
                than no button, and the count is what makes it worth pressing. */}
            {outstanding > 0 && (
              <button
                type="button"
                onClick={extractOutstanding}
                disabled={busy === "extract"}
                title="Extract every document that is not ready yet"
                className="flex items-center gap-1.5 rounded-full border border-scyne-line px-3 py-1 text-xs font-medium text-scyne-ink/70 transition-colors hover:border-scyne-ink hover:text-scyne-ink disabled:opacity-50"
              >
                <RefreshCw className={`size-3.5 ${busy === "extract" ? "animate-spin" : ""}`} aria-hidden />
                {busy === "extract" ? "Starting…" : `Extract ${outstanding}`}
              </button>
            )}
            <button
              type="button"
              onClick={load}
              className="rounded-full border border-scyne-line px-3 py-1 text-xs font-medium text-scyne-ink/70 hover:border-scyne-ink hover:text-scyne-ink"
            >
              Refresh
            </button>
          </div>
        </div>

        {project && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="relative inline-flex items-center">
              <Search className="pointer-events-none absolute left-2.5 size-3.5 text-scyne-ink/40" aria-hidden />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search documents"
                aria-label="Search documents by name"
                className="rounded-full border border-scyne-line py-1 pl-8 pr-3 text-xs outline-none placeholder:text-scyne-ink/40 focus:border-scyne-ink"
              />
            </span>
            <FilterSelect label="Folder" value={folder} onChange={setFolder} options={options.folders} />
            <FilterSelect label="Type" value={kind} onChange={setKind} options={options.kinds}
              render={(k) => (k === "unconverted" ? "not converted" : k)} />
            <FilterSelect label="Level" value={level} onChange={setLevel} options={options.levels} />
            <ClearFilters count={activeFilters} onClear={clear} />
          </div>
        )}
      </header>

      {note && (
        <p role="status" className="rounded-lg border border-scyne-line bg-scyne-ink-50 px-3 py-2 text-sm text-scyne-ink">
          {note}
        </p>
      )}

      {queue.length > 0 && <UploadQueue queue={queue} onDismiss={() => setQueue([])} />}

      {data?.db && (!data.db.projectInDb || data.db.notInDb > 0) && (
        <DriftNotice projectInDb={data.db.projectInDb} notInDb={data.db.notInDb} project={project!} />
      )}

      {!project ? (
        <p className="rounded-lg border border-dashed border-scyne-line px-3 py-6 text-center text-sm text-scyne-ink/60">
          Pick a project to see its documents.
        </p>
      ) : (
        <>
          <OpsState
            error={error}
            loading={data === null && !error}
            empty={false}
            emptyLabel=""
          />

          {data && (
            <div className="space-y-3">
              {folders.map((spec) => {
                const mine = shown.filter((d) => inFolder(d, spec));
                const total = all.filter((d) => inFolder(d, spec)).length;
                return (
                  <DocumentFolder
                    key={spec.id}
                    spec={spec}
                    docs={mine}
                    hiddenByFilter={total - mine.length}
                    view={view}
                    busy={busy}
                    onUpload={upload}
                    onPreview={setPreview}
                    onShowLog={setLogFor}
                    onReplace={pickReplacement}
                    onDelete={remove}
                  />
                );
              })}

              {!feature && (
                <p className="rounded-lg border border-dashed border-scyne-line px-3 py-4 text-center text-sm text-scyne-ink/60">
                  Pick a feature to see and add its discovery documents — SOP, Transcripts, Notes and UI.
                </p>
              )}
            </div>
          )}

          {data && data.stale.length > 0 && (
            <StalenessPanel
              stale={data.stale}
              selected={selected}
              onToggle={(key) => setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key); else next.add(key);
                return next;
              })}
              onRun={rerunSelected}
              running={busy === "rerun"}
              chosenCount={chosen.length}
            />
          )}
        </>
      )}

      <DocumentPreview doc={preview} project={project ?? ""} onClose={() => setPreview(null)} />
      <ExtractLogDialog
        doc={logFor}
        project={project ?? ""}
        onClose={() => setLogFor(null)}
        onRetried={load}
      />
    </div>
  );
}

/**
 * What the database does not know about.
 *
 * Disk is what the agents read, so this screen is right either way — but
 * `scyne doc list`, the console and every platform route read ROWS, and spend
 * is attributed through them. A document with no row is invisible to all of
 * that. Measured on this installation when the tab was built: 20 documents on
 * disk, 2 rows, three of four projects unknown to the database entirely.
 *
 * Said here rather than fixed here: writing 63 rows is not something a screen
 * should do because somebody opened it. It names the one command that does.
 */
function DriftNotice({
  projectInDb, notInDb, project,
}: {
  projectInDb: boolean; notInDb: number; project: string;
}) {
  return (
    <section className="rounded-lg border border-sky-300 bg-sky-50/60 p-3">
      <h2 className="text-sm font-semibold text-sky-900">
        {projectInDb
          ? `${notInDb} document${notInDb === 1 ? "" : "s"} not recorded in the database`
          : `${project} is not in the database`}
      </h2>
      <p className="mt-0.5 text-xs text-sky-900/80">
        {projectInDb
          ? "Every stage still reads them — disk is what the agents use. But they are invisible to "
          : "Its documents still reach every agent. But the project is invisible to "}
        <code className="rounded bg-white/70 px-1">scyne doc list</code>, the console and spend
        reporting. Reconcile with{" "}
        <code className="rounded bg-white/70 px-1">npm run sync:docs -- --apply</code>.
      </p>
    </section>
  );
}

/**
 * What is landing, and what happened to it.
 *
 * One in-flight state rather than separate "uploading" and "converting" steps:
 * the route does both in a single request, and a progress bar that claimed to
 * know when one ended and the other began would be describing something this
 * screen cannot see. What it CAN say truthfully is which file is in flight,
 * which are waiting, and what each one became.
 */
function UploadQueue({ queue, onDismiss }: { queue: QueueItem[]; onDismiss: () => void }) {
  const done = queue.filter((q) => q.state === "done").length;
  const failed = queue.filter((q) => q.state === "failed").length;
  const finished = done + failed === queue.length;

  return (
    <section
      aria-live="polite"
      className="rounded-lg border border-scyne-line bg-white p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-scyne-ink/60">
          {finished
            ? `${done} added${failed ? `, ${failed} failed` : ""}`
            : `Adding ${queue.length} file${queue.length === 1 ? "" : "s"} to ${queue[0].folder}`}
        </h2>
        {finished && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded p-1 text-scyne-ink/50 hover:bg-scyne-line/60 hover:text-scyne-ink"
            aria-label="Dismiss upload summary"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>

      <ul className="mt-2 space-y-1">
        {queue.map((q) => (
          <li key={q.id} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0">
              {q.state === "done" && <Check className="size-3.5 text-emerald-600" aria-hidden />}
              {q.state === "failed" && <X className="size-3.5 text-red-600" aria-hidden />}
              {q.state === "working" && <Loader2 className="size-3.5 animate-spin text-scyne-ink/60" aria-hidden />}
              {q.state === "queued" && <span className="block size-3.5 rounded-full border border-scyne-line" aria-hidden />}
            </span>
            <span className="min-w-0 flex-1 break-words">
              <span className="text-scyne-ink">{q.name}</span>
              <span className={`ml-2 text-[11px] ${q.state === "failed" ? "text-red-700" : "text-scyne-ink/55"}`}>
                {q.state === "queued" && "queued"}
                {q.state === "working" && "uploading & converting…"}
                {(q.state === "done" || q.state === "failed") && q.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>
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
    <section className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/60 p-4">
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
          const ok = canRerun(s.key);
          return (
            <li key={s.key}>
              <label className={`flex items-start gap-2 text-sm ${ok ? "" : "opacity-60"}`}>
                <input
                  type="checkbox"
                  checked={selected.has(s.key)}
                  onChange={() => onToggle(s.key)}
                  disabled={!ok || running}
                  className="mt-1 size-3.5 accent-amber-700"
                />
                <span>
                  <span className="font-medium text-amber-950">{s.label ?? s.key}</span>
                  <span className="text-amber-900/70">
                    {" "}— superseded by {s.supersededBy.map((b) => b.label).join(", ")}
                  </span>
                  {!ok && (
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
