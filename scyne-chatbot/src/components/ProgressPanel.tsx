import { useState } from "react";
import { GitBranch, Loader2, Pause, Play, X, Zap } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pauseIssue, cancelIssue, resumeIssue } from "../api";
import type { IssueProgress } from "../types";

type Tone = React.ComponentProps<typeof Badge>["tone"];

function statusTone(s: string): Tone {
  switch (s) {
    case "todo": return "neutral";
    case "in_progress": return "progress";
    case "in_review": return "warning";
    case "done": return "success";
    case "blocked": return "danger";
    case "paused": return "warning";
    case "cancelled": return "neutral";
    default: return "neutral";
  }
}

/** Nothing left to do to an issue in one of these. */
const FINISHED = new Set(["done", "cancelled"]);

/**
 * A run can be stopped two ways and the difference is worth a button each.
 *
 * Pause lets the step in flight finish — nothing is discarded, but an agent
 * step takes tens of minutes, so it is not immediate. Stop now kills the agent
 * where it stands and loses that step's work. Cancel ends the issue for good.
 *
 * Only the two destructive ones confirm. Pause is reversible, and a
 * confirmation on a reversible action just trains people to click through
 * confirmations.
 */
function Controls({ issue, onChanged }: { issue: IssueProgress; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (FINISHED.has(issue.status)) return null;

  const act = async (label: string, fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(label);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const btn = "grid place-items-center size-6 rounded hover:bg-muted text-muted-foreground " +
              "hover:text-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none";

  const paused = issue.status === "paused";

  return (
    <div className="flex items-center gap-0.5 shrink-0">
      {error && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[11px] text-red-600 mr-1 cursor-help">failed</span>
          </TooltipTrigger>
          <TooltipContent>{error}</TooltipContent>
        </Tooltip>
      )}

      {paused ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={btn}
              disabled={busy !== null}
              aria-label={`Resume ${issue.identifier}`}
              onClick={() => act("resume", () => resumeIssue(issue.id))}
            >
              {busy === "resume" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>Resume from where it stopped</TooltipContent>
        </Tooltip>
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={btn}
                disabled={busy !== null}
                aria-label={`Pause ${issue.identifier}`}
                onClick={() => act("pause", () => pauseIssue(issue.id, false))}
              >
                {busy === "pause" ? <Loader2 className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Pause — the step in flight finishes first, so this is not immediate
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={btn}
                disabled={busy !== null}
                aria-label={`Stop ${issue.identifier} now`}
                onClick={() => act("force", () => pauseIssue(issue.id, true),
                  `Stop ${issue.identifier} now?\n\nThe agent is killed where it stands and that step's ` +
                  `work is lost. The issue can still be resumed — the step will run again from the start.`)}
              >
                {busy === "force" ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>Stop the agent now — loses this step's work</TooltipContent>
          </Tooltip>
        </>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={btn + " hover:text-red-600"}
            disabled={busy !== null}
            aria-label={`Cancel ${issue.identifier}`}
            onClick={() => act("cancel", () => cancelIssue(issue.id),
              `Cancel ${issue.identifier}?\n\nIt cannot be resumed. Start the workflow again if you change your mind.`)}
          >
            {busy === "cancel" ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>Cancel — this cannot be undone</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function ProgressPanel({ items, onChanged }: { items: IssueProgress[]; onChanged?: () => void }) {
  if (!items.length) return null;
  return (
    <Card elevation={1} className="h-full flex flex-col min-h-0">
      <CardHeader className="shrink-0">
        <CardTitle>
          <GitBranch className="size-3.5 text-scyne-ink-500" />
          Workflow
          <Badge tone="neutral" size="sm" className="ml-auto normal-case tracking-normal">
            {items.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-0.5 flex-1 min-h-0 overflow-y-auto">
        {items.map((i) => (
          <div
            key={i.identifier}
            className="group flex items-center gap-2 text-sm px-2 h-8 rounded-md hover:bg-muted/60 transition-colors"
          >
            <Badge tone="mono" size="sm" className="shrink-0">{i.identifier}</Badge>
            <span className="flex-1 truncate text-slate-800">{i.title}</span>
            {/* Kept out of the way until the row is hovered or focused: these
                are destructive controls sitting in a list people read far more
                often than they act on. */}
            <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <Controls issue={i} onChanged={onChanged ?? (() => {})} />
            </div>
            <Badge tone={statusTone(i.status)} size="sm" pulse={i.status === "in_progress"}>
              {i.status.replace("_", " ")}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
