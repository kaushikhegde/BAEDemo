import { useEffect, useMemo, useState } from "react";
import { getIssues, type OpsIssue } from "../api";
import { OpsState, FilterSelect, ClearFilters, ago } from "./OpsState";

/**
 * Every issue in the company, and which of them are waiting on a person.
 *
 * Selecting one is the point: it sets the app's active issue and returns to
 * Chat, where the Activity panel already knows how to render an issue from
 * `/api/status/:id`. Before this, the only issue you could look at was the one
 * you had most recently started in this browser — a run begun yesterday, or by
 * a colleague, was unreachable from here.
 *
 * **Nothing is filtered by default.** The first version opened scoped to the
 * pinned project AND to open issues only, which meant a list headed "Issues"
 * showing one row out of forty, with no indication that thirty-nine had been
 * hidden by a default nobody chose. A filter is something you apply; the
 * unfiltered list is what "Issues" means.
 */

const STATUS_STYLE: Record<string, string> = {
  in_review: "bg-amber-100 text-amber-900",
  blocked: "bg-red-100 text-red-900",
  paused: "bg-slate-200 text-slate-800",
  in_progress: "bg-sky-100 text-sky-900",
  todo: "bg-scyne-line text-scyne-ink",
  done: "bg-emerald-100 text-emerald-900",
  cancelled: "bg-slate-100 text-slate-500",
};

/** Every status the engine can leave an issue in, in lifecycle order. */
const STATUSES = ["todo", "in_progress", "in_review", "blocked", "paused", "done", "cancelled"];

const ALL = "";   // the empty value every <select> uses for "no filter"

export function IssuesView({
  activeIssueId, onSelect,
}: {
  activeIssueId: string | null;
  onSelect: (issue: OpsIssue) => void;
}) {
  const [all, setAll] = useState<OpsIssue[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [status, setStatus] = useState(ALL);
  const [project, setProject] = useState(ALL);
  const [feature, setFeature] = useState(ALL);
  const [workflow, setWorkflow] = useState(ALL);
  const [waitingOnly, setWaitingOnly] = useState(false);

  // Fetched UNFILTERED and narrowed in the browser. The whole company's issues
  // is a small list, and holding it means the dropdowns can be built from what
  // actually exists — no empty option that returns nothing, and no second
  // request every time somebody changes their mind.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const data = await getIssues();
        if (!cancelled) { setAll(data); setError(null); }
      } catch (e) {
        // Stop polling on a refusal or an outage. Retrying every three seconds
        // against a role that will never be allowed is noise in a server log
        // and a spinner that never resolves on somebody's screen.
        if (!cancelled) { setError(e); setAll(null); }
        return;
      }
      if (!cancelled) timer = window.setTimeout(load, 3000);
    };
    load();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, []);

  const options = useMemo(() => {
    const uniq = (xs: Array<string | null>) =>
      [...new Set(xs.filter((x): x is string => Boolean(x)))].sort();
    return {
      // Features are listed for the SELECTED project only — a global feature
      // list mixes clients, and picking one that belongs to another project
      // silently returns nothing.
      projects: uniq((all ?? []).map(i => i.project)),
      features: uniq((all ?? []).filter(i => !project || i.project === project).map(i => i.feature)),
      workflows: uniq((all ?? []).map(i => i.workflow)),
      statuses: STATUSES.filter(s => (all ?? []).some(i => i.status === s)),
    };
  }, [all, project]);

  const rows = useMemo(() => (all ?? []).filter(i =>
    (!status || i.status === status)
    && (!project || i.project === project)
    && (!feature || i.feature === feature)
    && (!workflow || i.workflow === workflow)
    && (!waitingOnly || i.needsHuman)
  ), [all, status, project, feature, workflow, waitingOnly]);

  const active = [status, project, feature, workflow].filter(Boolean).length + (waitingOnly ? 1 : 0);
  const waiting = (all ?? []).filter(i => i.needsHuman).length;

  const clear = () => {
    setStatus(ALL); setProject(ALL); setFeature(ALL); setWorkflow(ALL); setWaitingOnly(false);
  };

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-scyne-ink">Issues</h1>
            <p className="text-sm text-scyne-ink/60">
              {all
                ? active
                  // Say what was hidden. A count with no denominator is how
                  // somebody concludes an issue was never created.
                  ? `${rows.length} of ${all.length}${waiting ? ` · ${waiting} waiting on you` : ""}`
                  : `${all.length} ${all.length === 1 ? "issue" : "issues"}${waiting ? ` · ${waiting} waiting on you` : ""}`
                : " "}
            </p>
          </div>
          {waiting > 0 && (
            <button
              type="button"
              onClick={() => setWaitingOnly(v => !v)}
              aria-pressed={waitingOnly}
              className={[
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                waitingOnly
                  ? "border-scyne-ink bg-scyne-ink text-white"
                  : "border-amber-300 bg-amber-50 text-amber-900 hover:border-amber-400",
              ].join(" ")}
            >
              {waiting} waiting on you
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect label="Status" value={status} onChange={setStatus}
            options={options.statuses} render={(s) => s.replace("_", " ")} />
          <FilterSelect label="Project" value={project}
            onChange={(v) => { setProject(v); setFeature(ALL); }} options={options.projects} />
          <FilterSelect label="Feature" value={feature} onChange={setFeature}
            options={options.features} />
          <FilterSelect label="Workflow" value={workflow} onChange={setWorkflow}
            options={options.workflows} />
          <ClearFilters count={active} onClear={clear} />
        </div>
      </header>

      <OpsState
        error={error}
        loading={all === null}
        empty={all !== null && rows.length === 0}
        emptyLabel={
          all && all.length > 0
            ? "No issue matches these filters."
            : "No issues yet — start one from Chat."
        }
      />

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-scyne-line bg-white">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Issues, oldest first. Select one to watch it in the Activity panel.
            </caption>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-scyne-ink/50">
                <th scope="col" className="px-3 py-2 font-semibold">Issue</th>
                <th scope="col" className="px-3 py-2 font-semibold">Status</th>
                <th scope="col" className="px-3 py-2 font-semibold">Step</th>
                <th scope="col" className="px-3 py-2 font-semibold">Workflow</th>
                <th scope="col" className="px-3 py-2 font-semibold">Target</th>
                <th scope="col" className="px-3 py-2 font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr
                  key={i.id}
                  onClick={() => onSelect(i)}
                  tabIndex={0}
                  role="button"
                  aria-label={`${i.identifier}, ${i.status.replace("_", " ")} — open in Activity`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(i); }
                  }}
                  className={[
                    "border-t border-scyne-line cursor-pointer transition-colors",
                    "hover:bg-scyne-line/40 focus:outline-none focus:bg-scyne-line/60",
                    i.id === activeIssueId ? "bg-scyne-line/50" : "",
                  ].join(" ")}
                >
                  <td className="px-3 py-2 font-semibold text-scyne-ink whitespace-nowrap">
                    {i.identifier}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${
                      STATUS_STYLE[i.status] ?? "bg-scyne-line text-scyne-ink"}`}>
                      {i.status.replace("_", " ")}
                    </span>
                    {/* A control request is honoured at the engine's next step
                        boundary, which can be twenty minutes away. An issue
                        reading `in progress` long after someone pressed Cancel
                        is this system's most confusing state, so it is named. */}
                    {i.controlRequest && (
                      <span className="ml-2 text-[11px] text-scyne-ink/60">
                        {i.controlRequest.replace("_", " ")} requested
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-scyne-ink/70">{i.step}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-scyne-ink/70">{i.workflow ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-scyne-ink/70">
                    {[i.project, i.feature].filter(Boolean).join(" / ") || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-scyne-ink/60">{ago(i.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
