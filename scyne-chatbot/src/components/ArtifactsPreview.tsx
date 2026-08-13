import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MiniMarkdown } from "./MiniMarkdown";
import { cn } from "@/lib/utils";
import type { Artifacts, ArtifactStory } from "../types";

// The BA writes Jira-payload-shaped stories. `description` may be either a
// plain string OR an Atlassian Document Format (ADF) document ({type:"doc",
// content:[...]}). Flatten ADF to a markdown-ish string so the existing regex
// + bullet parser still works. Bullets become `* text`, headings prefix `## `,
// paragraphs separate with blank lines.
function adfToText(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (typeof node !== "object") return String(node);
  const type = node.type;
  const children = Array.isArray(node.content) ? node.content : [];
  if (type === "text") return typeof node.text === "string" ? node.text : "";
  if (type === "hardBreak") return "\n";
  if (type === "paragraph") return adfToText(children) + "\n\n";
  if (type === "heading") {
    const lvl = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
    return "#".repeat(lvl) + " " + adfToText(children) + "\n\n";
  }
  if (type === "bulletList" || type === "orderedList") return adfToText(children);
  if (type === "listItem") return "* " + adfToText(children).replace(/\n+$/, "") + "\n";
  if (type === "codeBlock") return "```\n" + adfToText(children) + "\n```\n";
  // doc + any unknown container — just recurse.
  return adfToText(children);
}

function StoryCard({ s }: { s: ArtifactStory }) {
  const raw = s.description;
  const desc = typeof raw === "string" ? raw : adfToText(raw);
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

type ArtifactTab = "stories" | "summary" | "gaps" | "datamodel" | "solution" | "architecture" | "testcases" | "personas" | "capability";

export function ArtifactsPreview({ project, feature }: { project: string | null; feature: string | null }) {
  const [data, setData] = useState<Artifacts | null>(null);
  const [tab, setTab] = useState<ArtifactTab>("stories");

  useEffect(() => {
    if (!project || !feature) { setData(null); return; }
    const url = `/api/artifacts?project=${encodeURIComponent(project)}&feature=${encodeURIComponent(feature)}`;
    fetch(url).then((r) => r.json()).then(setData).catch(() => {});
  }, [project, feature]);

  if (!project || !feature) {
    return (
      <div className="mt-3 text-sm text-muted-foreground italic">
        Pick a project/feature in the target picker to preview the artifacts.
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mt-3 space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-3/4" />
      </div>
    );
  }

  const tabBtn = (key: ArtifactTab, label: string, count?: number) => (
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
        {data.dataModel && tabBtn("datamodel", "Data Model")}
        {data.solutionDesign && tabBtn("solution", "Solution Design")}
        {data.solutionArchitecture && tabBtn("architecture", "Solution Architecture")}
        {data.testCases && tabBtn("testcases", "Test Cases")}
        {data.personas && tabBtn("personas", "Personas & Journeys")}
        {data.capabilityMap && tabBtn("capability", "Capability Map")}
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
        {tab === "datamodel" && (
          <div className="text-slate-800">
            {data.dataModel ? (
              <MiniMarkdown source={data.dataModel} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No data model impact on disk yet.</div>
            )}
          </div>
        )}
        {tab === "solution" && (
          <div className="text-slate-800">
            {data.solutionDesign ? (
              <MiniMarkdown source={data.solutionDesign} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No solution design on disk yet.</div>
            )}
          </div>
        )}
        {tab === "architecture" && (
          <div className="text-slate-800">
            {data.solutionArchitecture ? (
              <MiniMarkdown source={data.solutionArchitecture} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No solution architecture on disk yet.</div>
            )}
          </div>
        )}
        {tab === "testcases" && (
          <div className="text-slate-800">
            {data.testCases ? (
              <MiniMarkdown source={data.testCases} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No test cases on disk yet.</div>
            )}
          </div>
        )}
        {tab === "personas" && (
          <div className="text-slate-800">
            {data.personas ? (
              <MiniMarkdown source={data.personas} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No personas or journey map on disk yet.</div>
            )}
          </div>
        )}
        {tab === "capability" && (
          <div className="text-slate-800">
            {data.capabilityMap ? (
              <>
                {/* The architect also renders a self-contained interactive page;
                    it opens in its own tab rather than inside this card. */}
                <a
                  href={`/api/capability-map/${encodeURIComponent(project)}/${encodeURIComponent(feature)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block mb-2 text-sm font-medium text-scyne-ink hover:underline"
                >
                  Open interactive map ↗
                </a>
                <MiniMarkdown source={data.capabilityMap} />
              </>
            ) : (
              <div className="text-sm text-muted-foreground italic">No capability map on disk yet.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
