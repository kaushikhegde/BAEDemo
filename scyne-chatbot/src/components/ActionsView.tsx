import { useEffect, useState } from "react";
import { getActions, summariseDetail, type ActionRow } from "../api";
import { OpsState, ago } from "./OpsState";

/**
 * Who did what, across the organisation.
 *
 * The audit trail rather than the activity timeline: a comment says what an
 * AGENT did on one issue, this says what a PERSON did anywhere — started a
 * run, approved a gate, cancelled something, changed a price. It answers "who
 * approved that?" weeks later, which no chat transcript can.
 */

// Verbs worth colouring, because they are the ones people go looking for.
// Verbs are dotted and namespaced — `doc.upload`, `gate.approve`, `issue.cancel`
// — so these match the ACTION half, not a bare word. Confirmed against live
// rows rather than guessed from the CLI's headings.
const TONE: Array<[RegExp, string]> = [
  [/approve/i, "bg-emerald-100 text-emerald-900"],
  [/reject|cancel|delete|disable|archive/i, "bg-red-100 text-red-900"],
  [/pause|resume|retry/i, "bg-amber-100 text-amber-900"],
  [/create|start|run|upload|add/i, "bg-sky-100 text-sky-900"],
];

const toneFor = (action: string): string =>
  TONE.find(([re]) => re.test(action))?.[1] ?? "bg-scyne-line text-scyne-ink";

export function ActionsView() {
  const [rows, setRows] = useState<ActionRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [limit, setLimit] = useState(100);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    getActions(limit)
      .then((d) => { if (!cancelled) setRows(d); })
      .catch((e) => { if (!cancelled) setError(e); });
    return () => { cancelled = true; };
  }, [limit]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-scyne-ink">Actions</h1>
          <p className="text-sm text-scyne-ink/60">
            {rows ? `${rows.length} most recent, newest first` : " "}
          </p>
        </div>
        {/* The cap is named rather than silent: a list that quietly stops at
            100 reads as "that is everything", which is how somebody concludes
            an action was never recorded. */}
        {rows && rows.length >= limit && (
          <button
            type="button"
            onClick={() => setLimit((n) => n + 200)}
            className="rounded-full border border-scyne-line px-3 py-1 text-xs font-medium text-scyne-ink/70 hover:border-scyne-ink/40"
          >
            Showing the newest {limit} — load more
          </button>
        )}
      </header>

      <OpsState
        error={error}
        loading={rows === null}
        empty={rows !== null && rows.length === 0}
        emptyLabel="Nothing recorded yet."
      />

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-scyne-line bg-white">
          <table className="w-full text-sm">
            <caption className="sr-only">Actions taken by people, newest first.</caption>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-scyne-ink/50">
                <th scope="col" className="px-3 py-2 font-semibold">When</th>
                <th scope="col" className="px-3 py-2 font-semibold">Who</th>
                <th scope="col" className="px-3 py-2 font-semibold">Did</th>
                <th scope="col" className="px-3 py-2 font-semibold">To</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a, i) => {
                const verb = String(a.verb ?? "—");
                // A row is attributed to a person OR to an agent, and null is a
                // real third value: an action taken before attribution existed,
                // or by an internal caller with no principal. Rendered as "—"
                // rather than back-filled — inventing an actor would be
                // inventing evidence.
                const who = a.user_email ?? (a.agent_key ? `${a.agent_key} (agent)` : null);
                const what = [a.project_name, a.target_type, summariseDetail(a.detail)]
                  .filter(Boolean).join(" · ");
                return (
                  <tr key={String(a.id ?? i)} className="border-t border-scyne-line align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-scyne-ink/60">{ago(a.created_at)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-scyne-ink">
                      {who ?? <span className="text-scyne-ink/40">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${toneFor(verb)}`}>
                        {verb.replace(/[_.]/g, " ")}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-scyne-ink/70 break-all">{what || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
