import { useEffect, useState } from "react";
import { ArrowUpRight, FileText, History as HistoryIcon, RefreshCw, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getHistory, type HistoryEntry } from "../api";
import { prettyWikiPage, workItemId } from "@/lib/links";

function prettyDate(iso: string | null) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }
  catch { return ""; }
}

function statusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "done") return "success";
  if (status === "blocked") return "warning";
  return "neutral";
}

export function HistoryView() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try { setEntries(await getHistory()); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  return (
    <div className="mx-auto max-w-[1100px] w-full flex flex-col gap-4 h-[calc(100vh-9rem)] min-h-0">
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <HistoryIcon className="size-5 text-scyne-ink-600" />
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Completed tasks</h1>
          {entries && (
            <Badge tone="neutral" size="sm" className="normal-case tracking-normal">{entries.length}</Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3">
        {error && (
          <Card elevation={0} className="p-4 text-sm text-amber-700 border-dashed border-amber-300 bg-amber-50/40">
            Couldn’t load history: {error}
          </Card>
        )}

        {!error && entries && entries.length === 0 && (
          <Card elevation={0} className="p-10 text-center text-sm text-muted-foreground border-dashed bg-white/40">
            <Sparkles className="size-5 mx-auto mb-2 text-scyne-ink-500/60" />
            <div className="font-medium text-foreground mb-1">No completed tasks yet</div>
            <div>Once a requirements run finishes and publishes to the wiki and work items, it’ll show up here.</div>
          </Card>
        )}

        {entries?.map((e) => {
          const total = e.links.wiki.length + e.links.workItems.length;
          return (
            <Card key={e.id} elevation={1} className="bg-white/70">
              <CardHeader>
                <CardTitle className="flex-wrap">
                  <FileText className="size-3.5 text-scyne-ink-500" />
                  <span className="normal-case tracking-normal text-[15px] font-semibold text-foreground">
                    {e.title.replace(/^Generate requirements —\s*/, "")}
                  </span>
                  <Badge tone="mono" size="sm" className="ml-1">{e.identifier}</Badge>
                  <Badge tone={statusTone(e.status)} size="sm" className="normal-case tracking-normal">{e.status}</Badge>
                  <span className="ml-auto text-xs font-normal text-muted-foreground">{prettyDate(e.completedAt)}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {total === 0 ? (
                  <div className="text-sm text-muted-foreground">No published links for this run yet.</div>
                ) : (
                  <>
                    {e.links.wiki.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">Wiki</div>
                        <div className="flex flex-col gap-1.5">
                          {e.links.wiki.map((u) => (
                            <Button key={u} asChild variant="outline" size="sm" className="justify-between w-full">
                              <a href={u} target="_blank" rel="noreferrer">
                                <span className="truncate text-left">{prettyWikiPage(u)}</span>
                                <ArrowUpRight className="shrink-0" />
                              </a>
                            </Button>
                          ))}
                        </div>
                      </div>
                    )}
                    {e.links.workItems.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                          Work Items ({e.links.workItems.length})
                        </div>
                        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                          {e.links.workItems.map((u) => {
                            const key = workItemId(u);
                            return (
                              <a key={u} href={u} target="_blank" rel="noreferrer"
                                 className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full">
                                <Badge tone="brand" size="sm" className="w-full justify-center hover:bg-scyne-ink-100 transition-colors">
                                  <span className="font-mono">{key}</span>
                                </Badge>
                              </a>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
