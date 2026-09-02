import { useEffect, useState, lazy, Suspense } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { renderCompanionApp } from "../api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Artifacts, ArtifactStory } from "../types";

// react-markdown + remark-gfm are ~160 kB, and this preview only renders behind
// the "Review what will be pushed" toggle — so it is code-split rather than
// carried in the initial bundle. Mermaid splits itself again inside Markdown.
const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

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
  // The companion app is redrawn by every workflow, but a run that blocks
  // before its render step leaves the page stale with the artefacts already on
  // disk — so the reader needs a way to redraw it that is not "run the stage
  // again". One piece of state for all three outcomes: a second boolean for
  // "done" would let a stale success sit next to a fresh error.
  const [rerender, setRerender] = useState<
    { state: "idle" } | { state: "busy" } | { state: "done"; at: number } | { state: "error"; message: string }
  >({ state: "idle" });

  // A project-level gate (capability map, personas) has no feature, and the
  // backend serves those from `?project=` alone. Gating on both here is what
  // used to leave a project approval with nothing to review.
  useEffect(() => {
    if (!project) { setData(null); return; }
    const url = feature
      ? `/api/artifacts?project=${encodeURIComponent(project)}&feature=${encodeURIComponent(feature)}`
      : `/api/artifacts?project=${encodeURIComponent(project)}`;
    fetch(url).then((r) => r.json()).then(setData).catch(() => {});
    // A result from the previous project says nothing about this one.
    setRerender({ state: "idle" });
  }, [project, feature]);

  async function onRerender() {
    if (!project) return;
    setRerender({ state: "busy" });
    try {
      await renderCompanionApp(project);
      setRerender({ state: "done", at: Date.now() });
    } catch (e: any) {
      // The server's own words — a project with nothing generated comes back
      // saying exactly that, which is not the same news as a failed render.
      setRerender({ state: "error", message: e?.message ?? String(e) });
    }
  }

  if (!project) {
    return (
      <div className="mt-3 text-sm text-muted-foreground italic">
        Pick a project in the target picker to preview the artifacts.
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

  // Which tabs this target can actually show. Feature-scoped artefacts are
  // hidden entirely on a project-level gate, so the card never opens on an
  // empty "Stories" tab for a project that has no features yet.
  const visible: ArtifactTab[] = [
    ...(feature ? (["stories", "summary", "gaps"] as ArtifactTab[]) : []),
    ...(feature && data.dataModel ? (["datamodel"] as ArtifactTab[]) : []),
    ...(feature && data.solutionDesign ? (["solution"] as ArtifactTab[]) : []),
    ...(feature && data.solutionArchitecture ? (["architecture"] as ArtifactTab[]) : []),
    ...(feature && data.testCases ? (["testcases"] as ArtifactTab[]) : []),
    ...(data.capabilityMap ? (["capability"] as ArtifactTab[]) : []),
    ...(data.personas ? (["personas"] as ArtifactTab[]) : []),
  ];

  if (visible.length === 0) {
    return (
      <div className="mt-3 text-sm text-muted-foreground italic">
        Nothing generated for <span className="font-medium not-italic">{feature ? `${project} / ${feature}` : project}</span> yet.
      </div>
    );
  }

  // Fall back rather than persist a selection this target can't render — `tab`
  // survives a target change, and "stories" is the initial value.
  const active: ArtifactTab = visible.includes(tab) ? tab : visible[0];

  const tabBtn = (key: ArtifactTab, label: string, count?: number) => (
    <Button
      key={key}
      onClick={() => setTab(key)}
      variant="ghost"
      size="sm"
      className={cn(
        "rounded-full",
        active === key && "bg-secondary text-secondary-foreground hover:bg-secondary"
      )}
    >
      {label}{typeof count === "number" ? ` · ${count}` : ""}
    </Button>
  );

  const LABELS: Record<ArtifactTab, string> = {
    stories: "Stories",
    summary: "Product Summary",
    gaps: "Gaps",
    datamodel: "Data Model",
    solution: "Solution Design",
    architecture: "Solution Architecture",
    testcases: "Test Cases",
    personas: "Personas & Journeys",
    capability: "Capability Map",
  };

  return (
    <div className="mt-3 space-y-3">
      <div className="flex gap-1.5 flex-wrap">
        {visible.map((k) => tabBtn(k, LABELS[k], k === "stories" ? data.stories.length : undefined))}
      </div>
      {/* 320px was fine for a bullet list; these documents run to hundreds of
          table rows and a dozen diagrams, and a gate the reviewer cannot
          actually read is a gate in name only. */}
      <div className="max-h-[60vh] overflow-y-auto pr-1">
        <Suspense fallback={<div className="space-y-2 py-2"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /></div>}>
        {active === "stories" && (
          <div className="space-y-2">
            {data.stories.length === 0 && (
              <div className="text-sm text-muted-foreground italic py-4 text-center">
                No stories on disk yet.
              </div>
            )}
            {data.stories.map((s, i) => <StoryCard key={i} s={s} />)}
          </div>
        )}
        {active === "summary" && (
          <div className="text-slate-800">
            {data.productSummary ? (
              <Markdown source={data.productSummary} />
            ) : (
              <div className="text-sm text-muted-foreground italic">Product summary not found.</div>
            )}
          </div>
        )}
        {active === "gaps" && (
          <div className="text-slate-800">
            {data.gaps ? (
              <Markdown source={data.gaps} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No gaps file (or empty).</div>
            )}
          </div>
        )}
        {active === "datamodel" && (
          <div className="text-slate-800">
            {data.dataModel ? (
              <Markdown source={data.dataModel} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No data model impact on disk yet.</div>
            )}
          </div>
        )}
        {active === "solution" && (
          <div className="text-slate-800">
            {data.solutionDesign ? (
              <Markdown source={data.solutionDesign} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No solution design on disk yet.</div>
            )}
          </div>
        )}
        {active === "architecture" && (
          <div className="text-slate-800">
            {data.solutionArchitecture ? (
              <Markdown source={data.solutionArchitecture} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No solution architecture on disk yet.</div>
            )}
          </div>
        )}
        {active === "testcases" && (
          <div className="text-slate-800">
            {data.testCases ? (
              <Markdown source={data.testCases} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No test cases on disk yet.</div>
            )}
          </div>
        )}
        {active === "personas" && (
          <div className="text-slate-800">
            {data.personas ? (
              <Markdown source={data.personas} />
            ) : (
              <div className="text-sm text-muted-foreground italic">No personas or journey map on disk yet.</div>
            )}
          </div>
        )}
        {active === "capability" && (
          <div className="text-slate-800">
            {data.capabilityMap ? (
              <>
                {/* The architect also renders a self-contained interactive page;
                    it opens in its own tab rather than inside this card.

                    Re-render sits beside it because this is where somebody
                    notices the page is behind: they read the markdown here,
                    open the map, and find it showing an older run. */}
                <div className="mb-2 flex items-center gap-3">
                  <a
                    href={`/api/companion-app/${encodeURIComponent(project)}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-scyne-ink hover:underline"
                  >
                    Open interactive map ↗
                  </a>
                  <button
                    type="button"
                    onClick={onRerender}
                    disabled={rerender.state === "busy"}
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-scyne-ink disabled:opacity-60"
                    title="Redraw the companion app from the files currently on disk"
                  >
                    <RefreshCw className={cn("h-3.5 w-3.5", rerender.state === "busy" && "animate-spin")} />
                    {rerender.state === "busy" ? "Re-rendering…" : "Re-render"}
                  </button>
                </div>
                {rerender.state === "done" && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    Companion app updated. Reopen the map to see it.
                  </p>
                )}
                {rerender.state === "error" && (
                  <p className="mb-2 text-xs text-destructive whitespace-pre-wrap">{rerender.message}</p>
                )}
                <Markdown source={data.capabilityMap} />
              </>
            ) : (
              <div className="text-sm text-muted-foreground italic">No capability map on disk yet.</div>
            )}
          </div>
        )}
        </Suspense>
      </div>
    </div>
  );
}
