import { useEffect, useRef } from "react";
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastIdRef = useRef<string | null>(null);

  // Auto-scroll to the newest activity when a new item arrives. Tracking the
  // latest item's id (not just count) avoids fighting a user who scrolled up
  // to read older entries when nothing actually changed.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const newestId = items.length ? items[items.length - 1].id : null;
    if (newestId && newestId !== lastIdRef.current) {
      lastIdRef.current = newestId;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [items]);

  // Always render the card — an empty state placeholder is better than disappearing
  // entirely (which made the right pane look broken before any comments arrived).
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
      <div ref={scrollRef} className="px-4 pb-4 flex-1 min-h-0 overflow-y-auto">
        {items.length === 0 && (
          <p className="text-sm text-slate-400 italic py-2">
            No activity yet. Agent updates will appear here as the workflow progresses.
          </p>
        )}
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
