import { GitBranch } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { IssueProgress } from "../types";

type Tone = React.ComponentProps<typeof Badge>["tone"];

function statusTone(s: string): Tone {
  switch (s) {
    case "todo": return "neutral";
    case "in_progress": return "progress";
    case "in_review": return "warning";
    case "done": return "success";
    case "blocked": return "danger";
    default: return "neutral";
  }
}

export function ProgressPanel({ items }: { items: IssueProgress[] }) {
  if (!items.length) return null;
  return (
    <Card elevation={1}>
      <CardHeader>
        <CardTitle>
          <GitBranch className="size-3.5 text-scyne-ink-500" />
          Workflow
          <Badge tone="neutral" size="sm" className="ml-auto normal-case tracking-normal">
            {items.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-0.5">
        {items.map((i) => (
          <div
            key={i.identifier}
            className="flex items-center gap-2 text-sm px-2 h-8 rounded-md hover:bg-muted/60 transition-colors"
          >
            <Badge tone="mono" size="sm" className="shrink-0">{i.identifier}</Badge>
            <span className="flex-1 truncate text-slate-800">{i.title}</span>
            <Badge tone={statusTone(i.status)} size="sm" pulse={i.status === "in_progress"}>
              {i.status.replace("_", " ")}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
