import { useEffect, useState } from "react";
import { fetchSuggestions, type Chip } from "@/api";

/**
 * The row of chips above the composer.
 *
 * Every chip is `{label, message}` and clicking one sends `message` as an
 * ordinary chat turn — so a chip is indistinguishable from typing, and the LLM
 * needs no special handling for it. The server computes them from the pipeline
 * graph and what is on disk, so a chip is never offered for a stage whose
 * prerequisite is unmet: clicking one cannot produce a 409.
 */
export function SuggestionChips({
  project,
  feature,
  refreshKey,
  disabled,
  onPick,
}: {
  project: string | null;
  feature: string | null;
  /** Bump to re-fetch — the pipeline moved, so what is possible has changed. */
  refreshKey: number;
  disabled?: boolean;
  onPick: (message: string) => void;
}) {
  const [chips, setChips] = useState<Chip[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchSuggestions(project, feature).then((c) => {
      if (!cancelled) setChips(c);
    });
    return () => { cancelled = true; };
  }, [project, feature, refreshKey]);

  if (!chips.length) return null;

  return (
    <div className="flex flex-wrap gap-2 px-4 pb-2" role="group" aria-label="Suggested next steps">
      {chips.map((c) => (
        <button
          key={c.label}
          type="button"
          disabled={disabled}
          onClick={() => onPick(c.message)}
          className="rounded-full border border-scyne-line bg-white px-3 py-1.5 text-xs font-medium text-scyne-ink
                     transition-colors hover:border-scyne-ink hover:bg-scyne-ink hover:text-white
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-scyne-ink
                     disabled:cursor-not-allowed disabled:opacity-50"
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
