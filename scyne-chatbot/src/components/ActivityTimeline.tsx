import { MessageSquare } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { MiniMarkdown } from "./MiniMarkdown";
import type { ActivityItem } from "../types";

function shortTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}

export function ActivityTimeline({ items }: { items: ActivityItem[] }) {
  if (!items.length) return null;

  // Fills the remaining panel height; only this card's list scrolls (not the page).
  return (
    <Card elevation={1} className="flex-1 min-h-0 flex flex-col">
      <CardHeader className="shrink-0">
        <CardTitle>
          <MessageSquare className="size-3.5 text-scyne-ink-500" />
          Activity
          <Badge tone="neutral" size="sm" className="ml-auto normal-case tracking-normal">
            {items.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <div className="px-4 pb-4 flex-1 min-h-0 overflow-y-auto">
        {items.map((c, idx) => (
          <div key={c.id}>
            {idx > 0 && <Separator className="my-3" />}
            <div className="flex gap-3 animate-slide-up">
              <span
                aria-hidden
                className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-gradient shadow-glow"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center flex-wrap gap-1.5 text-xs text-muted-foreground mb-1">
                  <Badge tone="mono" size="sm">{c.issueIdentifier}</Badge>
                  <span className="font-medium text-slate-700">{c.author}</span>
                  <span>·</span>
                  <span>{shortTime(c.createdAt)}</span>
                </div>
                <div className="text-sm text-slate-800">
                  <MiniMarkdown source={String(c.body)} />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
