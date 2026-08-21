import { OpsError } from "../api";

/**
 * The three not-a-table states every ops view shares.
 *
 * Written once because the distinction between them is the whole point and is
 * easy to blur: an empty table, a refusal and an outage all render as "no
 * rows" if nobody is careful, and only one of those means there is nothing to
 * see. A member shown an empty Spend table concludes the install has cost
 * nothing.
 */
export function OpsState({ error, loading, empty, emptyLabel }: {
  error: unknown;
  loading: boolean;
  empty: boolean;
  emptyLabel: string;
}) {
  if (error instanceof OpsError && error.forbidden) {
    return (
      <Card
        title="Not visible to your role"
        body={`${error.message} Nothing is missing — this account is not permitted to read it.`}
      />
    );
  }
  if (error instanceof OpsError && error.unreachable) {
    return (
      <Card
        title="The orchestrator is not reachable"
        body={`${error.message} This app is running; the engine behind it is not, so there is nothing to show rather than nothing to see.`}
      />
    );
  }
  if (error) {
    return <Card title="That did not load" body={(error as Error).message ?? String(error)} />;
  }
  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading…</span>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-9 rounded-md bg-scyne-line/50 animate-pulse" />
        ))}
      </div>
    );
  }
  if (empty) return <Card title={emptyLabel} body="" muted />;
  return null;
}

function Card({ title, body, muted }: { title: string; body: string; muted?: boolean }) {
  return (
    <div
      role="status"
      className={[
        "rounded-lg border px-4 py-3",
        muted ? "border-scyne-line bg-white/50" : "border-scyne-line bg-white",
      ].join(" ")}
    >
      <p className="text-sm font-semibold text-scyne-ink">{title}</p>
      {body && <p className="text-sm text-scyne-ink/70 mt-1">{body}</p>}
    </div>
  );
}

/** `2h`, `22m`, `just now` — the same vocabulary `scyne issues` prints. */
export function ago(iso?: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  // Clock skew between this browser and the server reads as a negative age.
  // "just now" is the honest rendering; a negative number looks like a bug.
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** `$1.2345`, or `—` for a model with no published price — never `$0.0000`. */
export function money(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? `$${n.toFixed(4)}` : "—";
}

/**
 * One filter control, shared by every ops view.
 *
 * A real `<select>` rather than a row of chips: the values come from the data
 * and there can be a dozen of them, which is more than a chip row can hold
 * without wrapping into its own paragraph. Chips are used for the things that
 * are genuinely a small fixed set — a spend view's grouping, say — and the two
 * must not look alike, because "group by project" and "only project SAPN" are
 * completely different operations sitting inches apart.
 *
 * Disabled rather than hidden when there is nothing to choose: a control that
 * vanishes leaves somebody wondering whether they imagined it.
 */
export function FilterSelect({ label, value, onChange, options, render, disabled }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<string | { value: string; label: string }>;
  /** Optional display transform for plain-string options. */
  render?: (v: string) => string;
  disabled?: boolean;
}) {
  const id = `filter-${label.toLowerCase().replace(/\s+/g, "-")}`;
  const items = options.map((o) => (typeof o === "string" ? { value: o, label: render ? render(o) : o } : o));
  const off = !value;
  return (
    <span className="inline-flex items-center gap-1.5">
      <label htmlFor={id} className="text-[11px] uppercase tracking-wider text-scyne-ink/50">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled || items.length === 0}
        onChange={(e) => onChange(e.target.value)}
        className={[
          "rounded-full border px-2.5 py-1 text-xs font-medium",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          off ? "border-scyne-line bg-white text-scyne-ink/70" : "border-scyne-ink bg-scyne-ink text-white",
        ].join(" ")}
      >
        <option value="">All</option>
        {items.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </span>
  );
}

/** Wipe every filter, shown only when there is something to wipe. */
export function ClearFilters({ count, onClear }: { count: number; onClear: () => void }) {
  if (count < 1) return null;
  return (
    <button
      type="button"
      onClick={onClear}
      className="text-xs font-medium text-scyne-ink/60 underline underline-offset-2 hover:text-scyne-ink"
    >
      Clear {count === 1 ? "filter" : `${count} filters`}
    </button>
  );
}
