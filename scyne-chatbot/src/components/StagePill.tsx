import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { StatusSnapshot } from "../types";

type Tone = React.ComponentProps<typeof Badge>["tone"];

const MAP: Record<string, { tone: Tone; pulse: boolean; icon: React.ReactNode | null }> = {
  queued: { tone: "neutral", pulse: false, icon: null },
  pm_triaging: { tone: "progress", pulse: true, icon: <Loader2 className="animate-spin" /> },
  delegated: { tone: "progress", pulse: true, icon: <Loader2 className="animate-spin" /> },
  ba_generating: { tone: "progress", pulse: true, icon: <Loader2 className="animate-spin" /> },
  pushing: { tone: "progress", pulse: true, icon: <Loader2 className="animate-spin" /> },
  awaiting_approval: { tone: "warning", pulse: false, icon: <AlertCircle /> },
  done: { tone: "success", pulse: false, icon: <CheckCircle2 /> },
};

export function StagePill({ stage }: { stage: StatusSnapshot["stage"] }) {
  const m = MAP[stage.key] ?? MAP.queued;
  return (
    <div role="status" aria-live="polite">
      <Badge tone={m.tone} pulse={m.pulse && !m.icon} size="md">
        {m.icon}
        {stage.label}
      </Badge>
    </div>
  );
}
