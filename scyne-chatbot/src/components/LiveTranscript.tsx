import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bot, Wrench, ChevronDown, FileText, Sparkles } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { getAgentRuns, getTranscriptTail } from "../api";
import type { AgentRun, TranscriptEvent } from "../types";

interface RunCache {
  events: TranscriptEvent[];
  offset: number;
  status: string;
}

interface Props {
  parentIssueId: string | null;
}

const POLL_MS = 3000;

function iconFor(kind: TranscriptEvent["kind"]) {
  switch (kind) {
    case "assistant": return <Bot className="size-3.5 text-scyne-ink-600" />;
    case "tool_use": return <Wrench className="size-3.5 text-scyne-ink-500" />;
    case "tool_result": return <FileText className="size-3.5 text-slate-400" />;
    case "skill": return <Sparkles className="size-3.5 text-amber-500" />;
    default: return <Activity className="size-3.5 text-slate-400" />;
  }
}

function statusBadge(status: string) {
  if (status === "running") return <Badge variant="outline" className="text-emerald-600 border-emerald-300">live</Badge>;
  if (status === "succeeded") return <Badge variant="outline" className="text-slate-500">done</Badge>;
  if (status === "failed" || status === "errored") return <Badge variant="outline" className="text-red-600 border-red-300">failed</Badge>;
  if (status === "cancelled") return <Badge variant="outline" className="text-slate-500">cancelled</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

export function LiveTranscript({ parentIssueId }: Props) {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // "auto" follows the in-flight run; anything else is a manual pin.
  const [selection, setSelection] = useState<string | "auto">("auto");
  // Per-run buffer so switching agents doesn't lose history.
  const cacheRef = useRef<Map<string, RunCache>>(new Map());
  const [, setTick] = useState(0);
  const force = () => setTick((t) => t + 1);

  const selectedRunId = selection === "auto" ? activeRunId : selection;

  // 1. Poll the agent-runs index every 3s so the dropdown stays current and
  //    "auto" can follow whichever agent woke most recently.
  useEffect(() => {
    if (!parentIssueId) {
      setRuns([]); setActiveRunId(null); return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const snap = await getAgentRuns(parentIssueId);
        if (cancelled) return;
        setRuns(snap.runs);
        setActiveRunId(snap.activeRunId);
      } catch {
        // transient; next tick will retry
      }
    };
    tick();
    const h = window.setInterval(tick, POLL_MS);
    return () => { cancelled = true; window.clearInterval(h); };
  }, [parentIssueId]);

  // 2. Poll the selected run's transcript tail. Appends new events into the
  //    per-run cache. Stops polling once the run reaches a terminal status.
  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;

    const tick = async () => {
      const cache = cacheRef.current.get(selectedRunId)
        ?? { events: [], offset: 0, status: "running" };
      try {
        const tail = await getTranscriptTail(selectedRunId, cache.offset);
        if (cancelled) return;
        if (tail.events.length || tail.runStatus !== cache.status) {
          cacheRef.current.set(selectedRunId, {
            events: [...cache.events, ...tail.events],
            offset: tail.nextOffset,
            status: tail.runStatus,
          });
          force();
        }
        const terminal = tail.runStatus && tail.runStatus !== "running" && tail.runStatus !== "queued";
        if (terminal) {
          // One more poll already done — stop the interval.
          window.clearInterval(h);
        }
      } catch {
        // ignore; next tick will retry
      }
    };
    tick();
    const h = window.setInterval(tick, POLL_MS);
    return () => { cancelled = true; window.clearInterval(h); };
  }, [selectedRunId]);

  const cache = selectedRunId ? cacheRef.current.get(selectedRunId) : undefined;
  const events = cache?.events ?? [];

  // Auto-scroll to bottom on new events unless the user has scrolled up.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickyRef.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickyRef.current = atBottom;
  };

  // Choose what to show in the dropdown label.
  const selectedRun = useMemo(() => runs.find((r) => r.runId === selectedRunId), [runs, selectedRunId]);
  const autoLabel = activeRunId
    ? `Auto · ${runs.find((r) => r.runId === activeRunId)?.agentName ?? "active"}`
    : "Auto · waiting…";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wider text-scyne-ink-500">
            <Activity className="size-4" />
            Live Transcript
          </CardTitle>
          <div className="flex items-center gap-2">
            {selectedRun && statusBadge(selectedRun.status)}
            <div className="relative">
              <select
                value={selection}
                onChange={(e) => setSelection(e.target.value as any)}
                className="appearance-none rounded-md border border-scyne-line bg-white pl-2 pr-7 py-1 text-xs text-scyne-ink-700 focus:outline-none focus:ring-2 focus:ring-scyne-ink/30"
              >
                <option value="auto">{autoLabel}</option>
                {runs.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {r.agentName} · {r.issueIdentifier} · {r.status === "running" ? "live" : (r.status ?? "?")}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1.5 size-3.5 text-scyne-ink-400" />
            </div>
          </div>
        </div>
      </CardHeader>
      <Separator />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="max-h-[420px] overflow-y-auto p-3 text-xs font-mono leading-relaxed"
      >
        {events.length === 0 ? (
          <p className="text-slate-400 italic">
            {selectedRunId ? "Waiting for output…" : "No active agent run yet."}
          </p>
        ) : (
          <ol className="space-y-1.5">
            {events.map((e, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">{iconFor(e.kind)}</span>
                <span className="text-[10px] text-slate-400 tabular-nums shrink-0 w-14">{e.ts}</span>
                <span className="flex-1 break-words">
                  {e.kind === "assistant" && <span className="italic text-scyne-ink-800">{e.text}</span>}
                  {e.kind === "tool_use" && (
                    <span><span className="font-semibold text-scyne-ink-700">{e.tool}</span> · {e.preview}</span>
                  )}
                  {e.kind === "tool_result" && <span className="text-slate-500">↳ {e.preview}</span>}
                  {e.kind === "skill" && (
                    <span><span className="font-semibold text-amber-600">Skill</span> · {e.name}</span>
                  )}
                  {e.kind === "framing" && <span className="text-slate-400">{e.text}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
