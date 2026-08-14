import { useEffect, useRef, useState } from "react";
import { ExternalLink, Upload, RotateCw } from "lucide-react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { previewUrl } from "@/api";

interface PreviewEntry {
  port: number;
  pid: number | null;
  branch: string | null;
  repoUrl: string | null;
  appPath: string;
  status: string;
  devUrl: string;
  updatedAt?: string;
  /** Written by scripts/render-companion-app.mjs on every render. Drives the
   *  auto-reload below — the page is progressive, so every stage that completes
   *  re-renders it and this stamp changes. */
  generatedAt?: string;
  artefacts?: string[];
}

async function fetchPreview(project: string, feature?: string | null): Promise<PreviewEntry | null> {
  const r = await fetch(previewUrl(project, feature));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`preview fetch failed: ${r.status}`);
  return r.json();
}

interface PreviewPaneProps {
  project: string;
  /** Optional — the companion app is project-level. A project with no features
   *  still has a page, so this pane must render without one. */
  feature?: string | null;
  /** Called when the user submits a GitHub repo URL via the push form. */
  onPush?: (repoUrl: string) => Promise<void>;
}

export function PreviewPane({ project, feature, onPush }: PreviewPaneProps) {
  const [entry, setEntry] = useState<PreviewEntry | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [autoReloaded, setAutoReloaded] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [pushUrl, setPushUrl] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState<string | null>(null);
  // The render stamp this pane has already shown. A ref, not state: comparing it
  // must not itself trigger a re-render, or the poll and the reload chase
  // each other.
  const shownStamp = useRef<string | null>(null);

  useEffect(() => {
    // A different feature is a different page — forget the previous stamp so the
    // first poll for the new one is treated as a first load, not as an update.
    shownStamp.current = null;
    setAutoReloaded(false);
    let cancelled = false;
    const tick = async () => {
      try {
        const e = await fetchPreview(project, feature);
        if (cancelled) return;
        setEntry(e);
        // The companion app is progressive: every stage that finishes re-renders
        // it. Without this the iframe keeps showing the render that happened
        // whenever the tab was first opened, and the user has to know to hit
        // reload — so a stage they just approved looks like it did nothing.
        const stamp = e?.generatedAt ?? null;
        if (stamp) {
          if (shownStamp.current && shownStamp.current !== stamp) {
            setIframeKey((k) => k + 1);
            setAutoReloaded(true);
          }
          shownStamp.current = stamp;
        }
      } catch {
        /* swallow */
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [project, feature]);

  if (!entry) return null;

  // Cache-bust on top of the key remount. The route already sends no-store, so
  // this is belt-and-braces — and the query does not change how the page's own
  // relative links (mockups/…) resolve.
  const src = entry.generatedAt
    ? `${entry.devUrl}${entry.devUrl.includes("?") ? "&" : "?"}r=${encodeURIComponent(entry.generatedAt)}`
    : entry.devUrl;
  const renderedAt = entry.generatedAt
    ? new Date(entry.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  return (
    <Card elevation={1} className="p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-scyne-ink-600">
          Live Preview · {feature ? `${project}/${feature}` : project}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setIframeKey((k) => k + 1); setAutoReloaded(false); }}
            title="Reload preview"
            aria-label="Reload preview"
          >
            <RotateCw className="size-3.5" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            asChild
          >
            <a
              href={entry.devUrl}
              target="_blank"
              rel="noreferrer"
              title="Open preview in new tab"
              aria-label="Open preview in new tab"
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </Button>
          <Button
            size="sm"
            variant={entry.repoUrl ? "outline" : "default"}
            onClick={() => setPushOpen((v) => !v)}
            title={entry.repoUrl ? `Pushed to ${entry.repoUrl}` : "Push to GitHub"}
            aria-label={entry.repoUrl ? `Already pushed to ${entry.repoUrl}` : "Push to GitHub"}
          >
            <Upload className="size-3.5 mr-1" aria-hidden />
            {entry.repoUrl ? "Pushed" : "Push"}
          </Button>
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground truncate">
        {entry.devUrl}{entry.branch ? ` · branch ${entry.branch}` : ""}
        {renderedAt ? ` · rendered ${renderedAt}` : ""}
      </div>
      {/* aria-live so a screen reader hears the page changed under it. */}
      <div aria-live="polite" className="text-[10px] text-scyne-ink-600">
        {autoReloaded ? "Refreshed — a stage finished and re-rendered this page." : ""}
      </div>
      <iframe
        key={iframeKey}
        src={src}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        className="w-full h-[60vh] rounded-md border border-border bg-white"
        title={`Preview of ${feature ? `${project}/${feature}` : project}`}
      />
      {pushOpen && (
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          <label className="text-xs font-medium" htmlFor="push-repo-url">GitHub repo URL</label>
          <input
            id="push-repo-url"
            type="text"
            value={pushUrl}
            onChange={(e) => setPushUrl(e.target.value)}
            placeholder="git@github.com:org/repo.git"
            className="text-xs border border-border rounded px-2 py-1 bg-white"
          />
          {pushErr && <div className="text-xs text-destructive">{pushErr}</div>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPushOpen(false)} disabled={pushBusy}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!pushUrl.trim() || pushBusy}
              onClick={async () => {
                if (!onPush) { setPushErr("Push handler not wired up."); return; }
                setPushBusy(true); setPushErr(null);
                try {
                  await onPush(pushUrl.trim());
                  setPushOpen(false);
                  setPushUrl("");
                } catch (e: any) {
                  setPushErr(e?.message || String(e));
                } finally {
                  setPushBusy(false);
                }
              }}
            >
              {pushBusy ? "Pushing…" : "Push"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
