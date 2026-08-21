import { useEffect, useState } from "react";
import {
  getSpend, sinceFor, SPEND_PERIODS,
  type SpendDimension, type SpendPeriod, type SpendRow,
} from "../api";
import { OpsState, FilterSelect, ClearFilters, money } from "./OpsState";

/**
 * What the runs have cost, grouped one way and narrowed another.
 *
 * Two controls that look different because they ARE different: the chips
 * choose how rows are GROUPED, the dropdowns choose which runs are counted at
 * all. "Group by project" and "only project SAPN" sit inches apart and would
 * be indistinguishable rendered the same way.
 *
 * The two cost columns are NOT merged, and that is the important thing about
 * this screen. `reported` is the figure the vendor's own CLI printed;
 * `estimated` is ours, computed from the `model_prices` table because Codex
 * emits token counts and no dollar figure. A single blended number cannot be
 * audited — nobody reading it can tell which half came from a bill and which
 * from a price somebody typed.
 */

const DIMENSIONS: SpendDimension[] = ["project", "feature", "user", "agent", "adapter", "model"];

/**
 * What a null means, per dimension — and it is never "no data".
 *
 * The Spend view showed a single row labelled `—` holding the whole
 * installation's cost, which read as a rendering bug. It was not: `issues`
 * carried `project_id` that nothing ever wrote, so every run joined to no
 * project at all. That is fixed at the source, but a null can still be
 * legitimate — a run on an issue whose project was deleted, an agent step with
 * no agent row — and when it is, the row should say what it is rather than
 * render a dash that looks like a bug.
 */
const UNATTRIBUTED: Record<SpendDimension, string> = {
  project: "No project",
  feature: "No feature",
  user: "Started by the system",
  agent: "No agent",
  adapter: "Adapter not recorded",
  model: "Model not recorded",
};

const NAME: Record<SpendDimension, (r: SpendRow) => string | null | undefined> = {
  project: (r) => r.project_name,
  feature: (r) => r.feature_name,
  user: (r) => r.user_email,
  agent: (r) => r.agent_key,
  adapter: (r) => r.adapter,
  model: (r) => r.model,
};

/** The dimensions the API can also FILTER on, not merely group by. */
const FILTERABLE = ["project", "feature", "user"] as const;

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function SpendView() {
  const [by, setBy] = useState<SpendDimension>("project");
  const [rows, setRows] = useState<SpendRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [project, setProject] = useState("");
  const [feature, setFeature] = useState("");
  const [user, setUser] = useState("");
  const [period, setPeriod] = useState<SpendPeriod>("");

  /**
   * What each filter can be set to.
   *
   * Read from the UNFILTERED grouping on each of the three filterable
   * dimensions, which means every option is guaranteed to return something:
   * the list of projects that have spend IS `by=project` with no filters.
   * Fetched once, and not re-fetched as filters change — an option list that
   * shrinks as you use it makes it impossible to get back.
   */
  const [options, setOptions] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(FILTERABLE.map((d) => getSpend(d).catch(() => [] as SpendRow[])))
      .then((lists) => {
        if (cancelled) return;
        const next: Record<string, string[]> = {};
        FILTERABLE.forEach((d, i) => {
          next[d] = [...new Set(
            lists[i].map((r) => NAME[d](r)).filter((v): v is string => Boolean(v)),
          )].sort();
        });
        setOptions(next);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    const since = sinceFor(period);
    // No polling. Spend is a figure people read, not a run they watch, and a
    // three-second poll on an aggregate query buys nothing.
    getSpend(by, {
      ...(project ? { project } : {}),
      ...(feature ? { feature } : {}),
      ...(user ? { user } : {}),
      ...(since ? { since } : {}),
    })
      .then((d) => { if (!cancelled) setRows(d); })
      .catch((e) => { if (!cancelled) setError(e); });
    return () => { cancelled = true; };
  }, [by, project, feature, user, period]);

  const total = (rows ?? []).reduce(
    (acc, r) => ({
      runs: acc.runs + num(r.run_count),
      tokens: acc.tokens + num(r.input_tokens) + num(r.output_tokens),
      reported: acc.reported + num(r.reported_cost_usd),
      estimated: acc.estimated + num(r.estimated_cost_usd),
      unpriced: acc.unpriced + num(r.unpriced_run_count),
    }),
    { runs: 0, tokens: 0, reported: 0, estimated: 0, unpriced: 0 },
  );

  const activeFilters = [project, feature, user, period].filter(Boolean).length;
  const clear = () => { setProject(""); setFeature(""); setUser(""); setPeriod(""); };
  const periodLabel = SPEND_PERIODS.find((p) => p.value === period)?.label ?? "All time";

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <div>
          <h1 className="text-lg font-semibold text-scyne-ink">Spend</h1>
          <p className="text-sm text-scyne-ink/60">
            {rows
              ? `${total.runs} ${total.runs === 1 ? "run" : "runs"} · ` +
                `${money(total.reported)} reported` +
                (total.estimated ? ` + ~${money(total.estimated)} estimated` : "") +
                (period ? ` · ${periodLabel.toLowerCase()}` : "")
              : " "}
          </p>
        </div>

        {/* GROUPING. Chips, because it is a small fixed set and exactly one is
            always chosen — which is what a chip row says and a dropdown does not. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-scyne-ink/50 mr-1">
            Group by
          </span>
          {DIMENSIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setBy(d)}
              aria-pressed={by === d}
              className={[
                "rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors",
                by === d
                  ? "border-scyne-ink bg-scyne-ink text-white"
                  : "border-scyne-line text-scyne-ink/70 hover:border-scyne-ink/40",
              ].join(" ")}
            >
              {d}
            </button>
          ))}
        </div>

        {/* FILTERING. Dropdowns, deliberately unlike the chips above. */}
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect label="Period" value={period}
            onChange={(v) => setPeriod(v as SpendPeriod)}
            options={SPEND_PERIODS.filter((p) => p.value).map((p) => ({ value: p.value, label: p.label }))} />
          <FilterSelect label="Project" value={project}
            onChange={(v) => { setProject(v); setFeature(""); }} options={options.project ?? []} />
          <FilterSelect label="Feature" value={feature} onChange={setFeature}
            options={options.feature ?? []} />
          <FilterSelect label="User" value={user} onChange={setUser} options={options.user ?? []} />
          <ClearFilters count={activeFilters} onClear={clear} />
        </div>
      </header>

      <OpsState
        error={error}
        loading={rows === null}
        empty={rows !== null && rows.length === 0}
        emptyLabel={
          activeFilters
            ? "No runs match these filters."
            : "Nothing recorded yet."
        }
      />

      {rows && rows.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-scyne-line bg-white">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Spend by {by}{activeFilters ? ", filtered" : ""}. Dearest first.
              </caption>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-scyne-ink/50">
                  <th scope="col" className="px-3 py-2 font-semibold capitalize">{by}</th>
                  <th scope="col" className="px-3 py-2 font-semibold text-right">Runs</th>
                  <th scope="col" className="px-3 py-2 font-semibold text-right">Tokens</th>
                  <th scope="col" className="px-3 py-2 font-semibold text-right">Reported</th>
                  <th scope="col" className="px-3 py-2 font-semibold text-right">Estimated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-scyne-line">
                    <td className="px-3 py-2 font-medium text-scyne-ink">
                      {NAME[by](r) ?? (
                        <span className="italic font-normal text-scyne-ink/45">{UNATTRIBUTED[by]}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-scyne-ink/70">{r.run_count ?? 0}</td>
                    <td className="px-3 py-2 text-right text-scyne-ink/70">
                      {(num(r.input_tokens) + num(r.output_tokens)).toLocaleString("en-AU")}
                    </td>
                    <td className="px-3 py-2 text-right text-scyne-ink/70">{money(r.reported_cost_usd)}</td>
                    <td className="px-3 py-2 text-right text-scyne-ink/70">
                      {/* `~` on sight: this figure is ours, not a vendor's. */}
                      {r.estimated_cost_usd ? `~${money(r.estimated_cost_usd)}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 1 && (
                <tfoot>
                  <tr className="border-t-2 border-scyne-line font-semibold text-scyne-ink">
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 py-2 text-right">{total.runs}</td>
                    <td className="px-3 py-2 text-right">{total.tokens.toLocaleString("en-AU")}</td>
                    <td className="px-3 py-2 text-right">{money(total.reported)}</td>
                    <td className="px-3 py-2 text-right">
                      {total.estimated ? `~${money(total.estimated)}` : "—"}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {total.unpriced > 0 && (
            <p className="text-xs text-scyne-ink/55 max-w-prose">
              {total.unpriced} of these runs {total.unpriced === 1 ? "has" : "have"} no price at
              all — the model was never billed by a CLI and has no row in the price table, so it
              is counted in the run and token figures and in neither cost column. Add a rate with{" "}
              <code>scyne models set</code>.
            </p>
          )}

          {rows.some((r) => !NAME[by](r)) && (
            <p className="text-xs text-scyne-ink/55 max-w-prose">
              A run shows as <em>{UNATTRIBUTED[by].toLowerCase()}</em> when the issue behind it
              carries no {by}. Runs started before this install recorded {by}s are the usual
              reason; they are counted in the totals either way.
            </p>
          )}

          <p className="text-xs text-scyne-ink/55 max-w-prose">
            <strong>Reported</strong> is what the vendor's own CLI billed and printed.
            <strong> Estimated</strong> is computed here from the model price table, because
            Codex emits token counts and no dollar figure. They are shown separately rather
            than added together — a single number cannot be audited. A model with no
            published price stays <code>—</code>, never <code>$0.0000</code>.
          </p>
        </>
      )}
    </div>
  );
}
