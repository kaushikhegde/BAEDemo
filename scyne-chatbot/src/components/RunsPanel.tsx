import { Activity, Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { RunSummary } from "../api";

function dur(ms: number | null): string {
  if (ms == null) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const RUNNING = new Set(["queued", "running"]);

export function RunsPanel({ runs }: { runs: RunSummary[] }) {
  if (!runs.length) return null;
  return (
    <Card elevation={1} className="shrink-0">
      <CardHeader>
        <CardTitle>
          <Activity className="size-3.5 text-scyne-ink-500" />
          Agent runs
          <Badge tone="neutral" size="sm" className="ml-auto normal-case tracking-normal">{runs.length}</Badge>
        </CardTitle>
      </CardHeader>
      <div className="px-4 pb-3 flex flex-col gap-1.5">
        {runs.map((r) => {
          const live = RUNNING.has(r.status);
          return (
            <div key={r.runId} className="flex items-center gap-2 text-xs">
              {live
                ? <Loader2 className="size-3 shrink-0 animate-spin text-scyne-ink-500" />
                : <span aria-hidden className={`size-2 shrink-0 rounded-full ${r.status === "succeeded" ? "bg-emerald-500" : r.status === "failed" || r.status === "timed_out" ? "bg-red-500" : "bg-slate-300"}`} />}
              <span className="font-medium text-slate-700 truncate">{r.agent}</span>
              <span className="text-muted-foreground">
                {live ? "working…" : "worked"}{r.durationMs != null ? ` ${dur(r.durationMs)}` : ""}
                {!live && r.status !== "succeeded" ? ` · ${r.status}` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
