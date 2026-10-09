import { useState } from "react";
import { createProject, bootstrapProject, uploadProjectFile } from "@/api";
// The SAME rule the create route applies, imported rather than copied. A second
// copy here is exactly how the Next button came to light up on a name the
// server was about to refuse. `names.ts` is dependency-free, and tsconfig.app
// already includes `server`, so this bundles cleanly.
import { slugProjectName, isNewProjectName } from "../../server/names.js";

/**
 * Create a new project.
 *
 * Three steps: who the client is, their documents, then deploy. Features are
 * NOT created here — they arrive over weeks, so they are added from chat once
 * the project baseline exists.
 *
 * Deploy fires ONE issue (`Set up project — <project>`); the Delivery Lead runs
 * the capability map, then the personas, in that order, because journey stages
 * align to the capability model's L1 lifecycle phases.
 */

type Step = 1 | 2 | 3;

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: "Details" },
  { n: 2, label: "Documents" },
  { n: 3, label: "Review" },
];

export function NewProjectWizard({
  onCancel,
  onDeployed,
}: {
  onCancel: () => void;
  /** `readingFirst`: the documents are still being read, and the baseline starts by itself after. */
  onDeployed: (project: string, issueId: string, readingFirst?: boolean) => void;
}) {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brandNote, setBrandNote] = useState<string | null>(null);
  // The database half of creation. Not fatal — the tree, definition and
  // branding are real — but everything that resolves a project BY NAME stays
  // empty until the row exists, so it is said out loud rather than logged.
  const [dbNote, setDbNote] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  // Typed name in, created name out. Shown before anything is created, so the
  // person sees what they are getting rather than being refused for a space.
  const slug = slugProjectName(name);
  const nameOk = isNewProjectName(slug);
  const willRename = nameOk && slug !== name.trim();
  const canLeaveDetails = nameOk;

  // Step 1 → 2 is where the project is actually created, because the upload
  // route needs somewhere to put the files. Going back afterwards edits a
  // project that already exists, so the name is locked once created.
  async function createThenAdvance() {
    if (created) { setStep(2); return; }
    setBusy(true); setError(null);
    try {
      const r = await createProject(name.trim(), description.trim(), website.trim());
      setCreated(true);
      // Adopt the name it was CREATED under. Every later step — the uploads and
      // the deploy — sends `name`, and sending the typed one would file this
      // client's documents under a project that does not exist.
      if (r.project && r.project !== name.trim()) setName(r.project);
      if (r.dbError) setDbNote(r.dbError);
      if (r.brand?.brand) {
        setBrandNote(`Palette ${r.brand.brand}${r.brand.accent ? ` · accent ${r.brand.accent}` : ""}${r.brand.hasLogo ? " · logo found" : ""}`);
      } else if (r.brandError) {
        setBrandNote(`Couldn't read the branding (${r.brandError}). The Scyne palette will be used.`);
      }
      setStep(2);
    } catch (e: any) {
      setError(e?.message || "Could not create the project.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadAll() {
    if (!files.length) { setStep(3); return; }
    setBusy(true); setError(null);
    try {
      // Uploads are converted to markdown on arrival, so a PDF or DOCX dropped
      // here is readable by every skill without anything else happening.
      for (const f of files) await uploadProjectFile(name.trim(), f);
      setStep(3);
    } catch (e: any) {
      setError(e?.message || "Some files could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  async function deploy() {
    setBusy(true); setError(null);
    try {
      const issue = await bootstrapProject(name.trim());
      onDeployed(name.trim(), issue.id, issue.waitingFor === "documents");
    } catch (e: any) {
      setError(e?.message || "Could not start the project setup.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-scyne-ink">Create New Project</h1>
        <p className="mt-1 text-sm text-slate-500">Define the client, add their documents, and build the baseline.</p>
      </header>

      <ol className="flex items-center justify-center gap-2" aria-label="Progress">
        {STEPS.map((s, i) => {
          const done = step > s.n;
          const active = step === s.n;
          return (
            <li key={s.n} className="flex items-center gap-2">
              <div className="flex flex-col items-center gap-1">
                <span
                  aria-current={active ? "step" : undefined}
                  className={[
                    "flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold",
                    done ? "bg-emerald-500 text-white" : active ? "bg-scyne-ink text-white" : "border border-slate-300 text-slate-400",
                  ].join(" ")}
                >
                  {done ? "✓" : s.n}
                </span>
                <span className={`text-[10px] font-semibold uppercase tracking-wider ${active || done ? "text-scyne-ink" : "text-slate-400"}`}>
                  {s.label}
                </span>
              </div>
              {i < STEPS.length - 1 && <span className={`mb-4 h-px w-16 ${done ? "bg-emerald-500" : "bg-slate-200"}`} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>

      <div className="rounded-xl border border-scyne-line bg-white p-6 shadow-sm">
        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-scyne-ink">Project Information</h2>
              <p className="text-sm text-slate-500">Who the client is, and what they are here to do.</p>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Project name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={created}
                placeholder="e.g. SAPN"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-scyne-ink disabled:bg-slate-50"
              />
              {name && !nameOk && (
                <span className="text-xs text-red-600">Letters, numbers, spaces and . _ &amp; - only.</span>
              )}
              {!created && willRename && (
                <span className="text-xs text-slate-500">
                  Will be created as <strong className="font-semibold text-scyne-ink">{slug}</strong>{" "}
                  — it becomes the Azure DevOps project and the folder name. Feature names keep their spaces.
                </span>
              )}
              {created && <span className="text-xs text-slate-500">Created as {name} — the name is fixed now.</span>}
              {dbNote && (
                <span className="text-xs text-amber-700">
                  Created on disk, but not recorded in the database ({dbNote}). Runs will not be attributed to it
                  until that succeeds.
                </span>
              )}
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">About the client</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                placeholder="Who they are, what they are regulated or obliged to do, who their customers actually are, and what they cannot do."
                className="resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-scyne-ink"
              />
              <span className="text-xs text-slate-500">
                Every skill reads this before any discovery document. Without it they fall back to generic industry
                assumptions. {description.trim().length > 0 && description.trim().length < 40 && (
                  <strong className="text-amber-700">A couple of sentences, at least — this is too short to be saved.</strong>
                )}
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Their website (optional)</span>
              <input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://example.com.au"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-scyne-ink"
              />
              <span className="text-xs text-slate-500">Used to pull the palette, logo and wordmark for the companion app.</span>
            </label>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-scyne-ink">Documents</h2>
              <p className="text-sm text-slate-500">
                Anything that describes how the client works — policy, legislation, SOPs, transcripts, current-state
                architecture. Everything is converted to markdown automatically.
              </p>
            </div>

            <label
              className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-emerald-300 bg-emerald-50/40 px-6 py-10 text-center transition-colors hover:border-emerald-400"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files)]);
              }}
            >
              <span className="text-2xl" aria-hidden="true">⬆</span>
              <span className="text-sm font-medium text-scyne-ink">Drag and drop project documents</span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                PDF, DOCX, TXT, MD, XLSX
              </span>
              <span className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold">Browse system</span>
              <input
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])])}
              />
            </label>

            {files.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center justify-between rounded-lg border border-scyne-line px-3 py-1.5">
                    <span className="truncate">{f.name}</span>
                    <button
                      type="button"
                      className="text-xs text-slate-500 hover:text-red-600"
                      onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-slate-500">
              You can add more later, per feature, from the chat. This is the client-wide material every feature should see.
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-scyne-ink">Review</h2>
              <p className="text-sm text-slate-500">Check this, then build the baseline.</p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Project", value: name.trim() || "—" },
                { label: "Definition", value: description.trim().length >= 40 ? "Captured" : "Not supplied" },
                { label: "Documents", value: `${files.length} file${files.length === 1 ? "" : "s"}` },
              ].map((c) => (
                <div key={c.label} className="rounded-lg border border-scyne-line p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{c.label}</div>
                  <div className="mt-1 text-sm font-semibold text-scyne-ink">{c.value}</div>
                </div>
              ))}
            </div>
            {brandNote && <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{brandNote}</p>}
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <strong className="block">Deploy runs two stages, in order.</strong>
              The capability map first, then the personas — journeys align to the capability model's lifecycle phases.
              Each raises its own approval gate for you to review.
            </div>
          </div>
        )}

        {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => (step === 1 ? onCancel() : setStep((s) => (s - 1) as Step))}
          disabled={busy}
          className="text-sm font-semibold text-slate-500 hover:text-scyne-ink disabled:opacity-50"
        >
          {step === 1 ? "Cancel" : "Back"}
        </button>

        {step === 1 && (
          <button
            type="button"
            onClick={createThenAdvance}
            disabled={!canLeaveDetails || busy}
            className="rounded-lg bg-scyne-ink px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? "Creating…" : "Next step →"}
          </button>
        )}
        {step === 2 && (
          <button
            type="button"
            onClick={uploadAll}
            disabled={busy}
            className="rounded-lg bg-scyne-ink px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? "Uploading…" : files.length ? `Upload ${files.length} and continue →` : "Skip for now →"}
          </button>
        )}
        {step === 3 && (
          <button
            type="button"
            onClick={deploy}
            disabled={busy}
            className="rounded-lg bg-scyne-ink px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? "Starting…" : "Deploy →"}
          </button>
        )}
      </div>
    </div>
  );
}
