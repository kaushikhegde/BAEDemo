import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MiniMarkdown } from "./MiniMarkdown";
import { cn } from "@/lib/utils";
import type { Artifacts, ArtifactStory } from "../types";

function StoryCard({ s }: { s: ArtifactStory }) {
  const desc = s.description || "";
  const acMatch = desc.match(/Acceptance Criteria.*?\n([\s\S]*)/i);
  const acText = acMatch ? acMatch[1] : "";
  const bullets = acText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("*") || l.startsWith("-") || l.startsWith("•"))
    .map((l) => l.replace(/^[*\-•]+\s*/, ""))
    .filter(Boolean);
  return (
    <Card elevation={1} className="overflow-hidden">
      <details className="[&[open]>summary>svg]:rotate-180">
        <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-medium text-slate-800 hover:bg-muted/60 flex items-center gap-2">
          <ChevronDown className="size-4 text-muted-foreground transition-transform duration-200" />
          <span className="flex-1">{s.summary || "(untitled story)"}</span>
        </summary>
        <div className="px-3 pb-3 pt-1 text-sm text-slate-700 space-y-2 border-t border-slate-100">
          {bullets.length > 0 ? (
            <div>
              <div className="text-[10.5px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5 mt-2">
                Acceptance Criteria
              </div>
              <ul className="list-disc pl-5 space-y-1">{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap text-xs text-slate-600 font-mono mt-2">{desc}</pre>
          )}
        </div>
      </details>
    </Card>
  );
}

export function ArtifactsPreview() {
  const [data, setData] = useState<Artifacts | null>(null);
  const [tab, setTab] = useState<"stories" | "summary" | "gaps">("stories");

  useEffect(() => {
    fetch("/api/artifacts").then((r) => r.json()).then(setData).catch(() => {});
  }, []);

  if (!data) {
    return (
      <div className="mt-3 space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-3/4" />
      </div>
    );
  }

  const tabBtn = (key: typeof tab, label: string, count?: number) => (
    <Button
      key={key}
      onClick={() => setTab(key)}
      variant="ghost"
      size="sm"
      className={cn(
        "rounded-full",
        tab === key && "bg-secondary text-secondary-foreground hover:bg-secondary"
      )}
    >
      {label}{typeof count === "number" ? ` · ${count}` : ""}
    </Button>
  );

  return (
    <div className="mt-3 space-y-3">
      <div className="flex gap-1.5 flex-wrap">
        {tabBtn("stories", "Stories", data.stories.length)}
        {tabBtn("summary", "Product Summary")}
        {tabBtn("gaps", "Gaps")}
      </div>
      <div className="max-h-80 overflow-y-auto pr-1">
        {tab === "stories" && (
          <div className="space-y-2">
            {data.stories.length === 0 && (
              <div className="text-sm text-muted-foreground italic py-4 text-center">
                No stories on disk yet.
              </div>
            )}
            {data.stories.map((s, i) => <StoryCard key={i} s={s} />)}
          </div>
        )}
        {tab === "summary" && (
          <div className="text-slate-800">
            {data.productSummary ? (
              <MiniMarkdown source={data.productSummary} />
            ) : (
              <div className="text-sm text-muted-foreground italic">Product summary not found.</div>
            )}
          </div>
        )}
        {tab === "gaps" && (
          <div className="text-slate-800">
            {data.gaps ? (
              <MiniMarkdown source={data.gaps} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No gaps file (or empty).</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
