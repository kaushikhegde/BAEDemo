import { useEffect, useState } from "react";
import { ExternalLink, Upload, RotateCw } from "lucide-react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";

interface PreviewEntry {
  port: number;
  pid: number | null;
  branch: string | null;
  repoUrl: string | null;
  appPath: string;
  status: string;
  devUrl: string;
  updatedAt?: string;
}

async function fetchPreview(project: string, feature: string): Promise<PreviewEntry | null> {
  const r = await fetch(`/api/preview/${encodeURIComponent(project)}/${encodeURIComponent(feature)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`preview fetch failed: ${r.status}`);
  return r.json();
}

interface PreviewPaneProps {
  project: string;
  feature: string;
  /** Called when the user submits a GitHub repo URL via the push form. */
  onPush?: (repoUrl: string) => Promise<void>;
}

export function PreviewPane({ project, feature, onPush }: PreviewPaneProps) {
  const [entry, setEntry] = useState<PreviewEntry | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [pushOpen, setPushOpen] = useState(false);
  const [pushUrl, setPushUrl] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const e = await fetchPreview(project, feature);
        if (!cancelled) setEntry(e);
      } catch {
        /* swallow */
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [project, feature]);

  if (!entry) return null;

  return (
    <Card elevation={1} className="p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-scyne-ink-600">
          Live Preview · {project}/{feature}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setIframeKey((k) => k + 1)}
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
      </div>
      <iframe
        key={iframeKey}
        src={entry.devUrl}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        className="w-full h-[60vh] rounded-md border border-border bg-white"
        title={`Preview of ${project}/${feature}`}
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
