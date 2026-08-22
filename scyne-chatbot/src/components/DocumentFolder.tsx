import { useState } from "react";
import {
  FileText, Image as ImageIcon, Music, AlertTriangle, ChevronRight, ChevronDown,
  Trash2, Upload, FolderOpen, Plus,
} from "lucide-react";
import type { DocumentEntry } from "../api";
import { ago } from "./OpsState";

/**
 * One folder on disk, with everything you can do to it.
 *
 * A folder rather than a flat list with a "folder" column, because the folder
 * is not a label — it is what the pipeline reads. The BA treats SOP/ and
 * Transcripts/ differently (transcripts are the primary source of stories, SOPs
 * are context and explicitly not), the UX Designer treats requirements/UI/ as
 * authoritative, and a stage refusing with "no documents" is nearly always one
 * of these folders being empty. An EMPTY folder is therefore shown rather than
 * hidden: its emptiness is the answer.
 */

const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function KindIcon({ kind }: { kind: DocumentEntry["kind"] }) {
  const cls = "size-4 shrink-0 text-scyne-ink/40";
  if (kind === "image") return <ImageIcon className={cls} aria-hidden />;
  if (kind === "audio") return <Music className={cls} aria-hidden />;
  return <FileText className={cls} aria-hidden />;
}

/** Said once, in the one place it matters, rather than on every row. */
function Unconverted() {
  return (
    <span className="flex items-center gap-1 text-[11px] text-amber-700">
      <AlertTriangle className="size-3" aria-hidden />
      not converted — no stage can read this yet
    </span>
  );
}

export interface FolderSpec {
  /** Stable key, unique across the page: `project:documents`, `MVP:SOP`. */
  id: string;
  /** What the section is called — "PROJECT › documents", "MVP › SOP". */
  label: string;
  /** null for the project's own documents/. */
  feature: string | null;
  /** The upload hint this folder maps to; null means the project-level route. */
  hint: "sop" | "transcripts" | "notes" | "ui" | null;
  /** What a drop here accepts, for the file picker. */
  accept: string;
  blurb: string;
}

export function DocumentFolder({
  spec, docs, hiddenByFilter, view, busy, onUpload, onPreview, onReplace, onDelete,
}: {
  spec: FolderSpec;
  docs: DocumentEntry[];
  /** How many of this folder's documents the current filters are hiding. */
  hiddenByFilter: number;
  view: "table" | "grid";
  /** The path currently being acted on, or "upload" while files are landing. */
  busy: string | null;
  onUpload: (spec: FolderSpec, files: File[]) => void;
  onPreview: (d: DocumentEntry) => void;
  onReplace: (d: DocumentEntry) => void;
  onDelete: (d: DocumentEntry) => void;
}) {
  // Open by default. A collapsed-by-default tree makes you click four times to
  // answer "what has this project got", which is the question the tab exists for.
  const [open, setOpen] = useState(true);
  const [dragging, setDragging] = useState(false);

  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onUpload(spec, files);
  };

  return (
    <section className="rounded-lg border border-scyne-line bg-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-2 text-left"
        >
          {open
            ? <ChevronDown className="size-4 text-scyne-ink/50" aria-hidden />
            : <ChevronRight className="size-4 text-scyne-ink/50" aria-hidden />}
          <FolderOpen className="size-4 text-scyne-ink/40" aria-hidden />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-scyne-ink/70">
            {spec.label}
          </span>
          <span className="text-xs text-scyne-ink/50">
            {docs.length}
            {hiddenByFilter > 0 && <span className="ml-1">({hiddenByFilter} hidden)</span>}
          </span>
        </button>

        <label
          className={[
            "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
            "border-scyne-line text-scyne-ink/70 hover:border-scyne-ink hover:text-scyne-ink",
          ].join(" ")}
        >
          <Plus className="size-3.5" aria-hidden />
          Add
          <input
            type="file"
            multiple
            accept={spec.accept}
            className="sr-only"
            disabled={busy !== null}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";      // so the same file can be chosen twice
              if (files.length) onUpload(spec, files);
            }}
          />
        </label>
      </div>

      {open && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          className={[
            "border-t px-3 py-3 transition-colors",
            dragging ? "border-scyne-ink bg-scyne-ink-50" : "border-scyne-line",
          ].join(" ")}
        >
          {dragging && (
            <p className="mb-2 text-center text-sm font-medium text-scyne-ink">
              Drop to add to {spec.label}
            </p>
          )}

          {docs.length === 0 ? (
            <p className="py-3 text-center text-sm text-scyne-ink/50">
              {hiddenByFilter > 0
                ? `${hiddenByFilter} hidden by the filters.`
                : <>Empty — drop files here. <span className="text-scyne-ink/40">{spec.blurb}</span></>}
            </p>
          ) : view === "grid" ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {docs.map((d) => (
                <Card key={d.path} d={d} busy={busy} onPreview={onPreview} onReplace={onReplace} onDelete={onDelete} />
              ))}
            </div>
          ) : (
            <Table docs={docs} busy={busy} onPreview={onPreview} onReplace={onReplace} onDelete={onDelete} />
          )}
        </div>
      )}
    </section>
  );
}

function Actions({
  d, busy, onReplace, onDelete,
}: {
  d: DocumentEntry; busy: string | null;
  onReplace: (d: DocumentEntry) => void; onDelete: (d: DocumentEntry) => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onReplace(d); }}
        disabled={busy !== null}
        aria-label={`Replace ${d.name}`}
        title="Replace with a new file"
        className="rounded p-1.5 text-scyne-ink/60 hover:bg-scyne-line/60 hover:text-scyne-ink disabled:opacity-40"
      >
        <Upload className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(d); }}
        disabled={busy !== null}
        aria-label={`Delete ${d.name}`}
        title="Delete, with its archived original"
        className="rounded p-1.5 text-scyne-ink/60 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
    </>
  );
}

function Card({
  d, busy, onPreview, onReplace, onDelete,
}: {
  d: DocumentEntry; busy: string | null;
  onPreview: (d: DocumentEntry) => void;
  onReplace: (d: DocumentEntry) => void;
  onDelete: (d: DocumentEntry) => void;
}) {
  const readable = d.kind === "markdown" || d.kind === "unconverted";
  return (
    <article
      onClick={() => readable && onPreview(d)}
      onKeyDown={(e) => {
        if (readable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPreview(d); }
      }}
      tabIndex={readable ? 0 : -1}
      role={readable ? "button" : undefined}
      aria-label={readable ? `Preview ${d.name}` : undefined}
      className={[
        "flex flex-col rounded-lg border border-scyne-line bg-white p-3 transition-colors",
        readable ? "cursor-pointer hover:border-scyne-ink/40 focus:outline-none focus:border-scyne-ink" : "",
      ].join(" ")}
    >
      <span className="flex items-start gap-2">
        <KindIcon kind={d.kind} />
        <span className="min-w-0 flex-1 break-words text-sm font-medium text-scyne-ink">{d.name}</span>
      </span>
      {d.original && (
        <span className="mt-0.5 pl-6 text-[11px] text-scyne-ink/50">
          from {d.original.split("/").pop()}
        </span>
      )}

      {/* Raw markdown, not rendered: at this size a heading and two lines read
          perfectly well as text, while a rendered fragment of a document whose
          first block is a 40-column table reads as nothing at all. */}
      {d.excerpt
        ? (
          <p className="mt-2 line-clamp-5 whitespace-pre-wrap break-words border-t border-scyne-line pt-2 font-mono text-[11px] leading-snug text-scyne-ink/60">
            {d.excerpt}
          </p>
        )
        : (
          <p className="mt-2 border-t border-scyne-line pt-2 text-[11px] italic text-scyne-ink/40">
            {d.kind === "markdown" ? "empty" : `${d.kind} — no preview`}
          </p>
        )}

      {d.kind === "unconverted" && <span className="mt-2"><Unconverted /></span>}

      <span className="mt-2 flex items-center justify-between border-t border-scyne-line pt-2">
        <span className="text-[11px] text-scyne-ink/50">{bytes(d.bytes)} · {ago(d.modifiedAt)}</span>
        <span className="flex items-center"><Actions d={d} busy={busy} onReplace={onReplace} onDelete={onDelete} /></span>
      </span>
    </article>
  );
}

function Table({
  docs, busy, onPreview, onReplace, onDelete,
}: {
  docs: DocumentEntry[]; busy: string | null;
  onPreview: (d: DocumentEntry) => void;
  onReplace: (d: DocumentEntry) => void;
  onDelete: (d: DocumentEntry) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Documents in this folder. Select one to read it.</caption>
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-scyne-ink/50">
            <th scope="col" className="px-1 py-1.5 font-semibold">Document</th>
            <th scope="col" className="px-1 py-1.5 font-semibold">Size</th>
            <th scope="col" className="px-1 py-1.5 font-semibold">Changed</th>
            <th scope="col" className="px-1 py-1.5 font-semibold text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => {
            const readable = d.kind === "markdown" || d.kind === "unconverted";
            return (
              <tr
                key={d.path}
                onClick={() => readable && onPreview(d)}
                onKeyDown={(e) => {
                  if (readable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPreview(d); }
                }}
                tabIndex={readable ? 0 : -1}
                role={readable ? "button" : undefined}
                aria-label={readable ? `Preview ${d.name}` : undefined}
                className={[
                  "border-t border-scyne-line",
                  readable ? "cursor-pointer hover:bg-scyne-line/40 focus:outline-none focus:bg-scyne-line/60" : "",
                ].join(" ")}
              >
                <td className="px-1 py-2">
                  <span className="flex items-center gap-2">
                    <KindIcon kind={d.kind} />
                    <span className="font-medium text-scyne-ink">{d.name}</span>
                  </span>
                  {d.original && (
                    <span className="ml-6 block text-[11px] text-scyne-ink/50">
                      from {d.original.split("/").pop()}
                    </span>
                  )}
                  {d.kind === "unconverted" && <span className="ml-6 mt-0.5 block"><Unconverted /></span>}
                </td>
                <td className="whitespace-nowrap px-1 py-2 text-scyne-ink/60">{bytes(d.bytes)}</td>
                <td className="whitespace-nowrap px-1 py-2 text-scyne-ink/60">{ago(d.modifiedAt)}</td>
                <td className="whitespace-nowrap px-1 py-2 text-right">
                  <Actions d={d} busy={busy} onReplace={onReplace} onDelete={onDelete} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
