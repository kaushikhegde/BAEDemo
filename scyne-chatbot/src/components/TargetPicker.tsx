import { useEffect, useState } from "react";
import { ChevronDown, Plus, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { createTarget } from "@/api";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Feature {
  name: string;
  counts: Record<string, number>;
}

interface Props {
  project: string | null;
  feature: string | null;
  onChange: (project: string | null, feature: string | null) => void;
  /** Called after a new project/feature is created so the parent can refresh + select it. */
  onCreated?: (project: string, feature: string) => void;
  refreshKey?: number;
}

export function TargetPicker({ project, feature, onChange, onCreated, refreshKey }: Props) {
  const [tree, setTree] = useState<Record<string, Feature[]>>({});
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newProject, setNewProject] = useState("");
  const [newFeature, setNewFeature] = useState("");
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const NAME_RE = /^[A-Za-z0-9._-]+$/;

  async function handleCreate() {
    const p = newProject.trim();
    const f = newFeature.trim();
    if (!NAME_RE.test(p) || !NAME_RE.test(f)) {
      setCreateErr("Use letters, numbers, dot, dash or underscore — no spaces.");
      return;
    }
    setBusy(true);
    setCreateErr(null);
    try {
      await createTarget(p, f);
      onChange(p, f);
      onCreated?.(p, f);
      setCreating(false);
      setNewProject("");
      setNewFeature("");
      setOpen(false);
    } catch (e: any) {
      setCreateErr(e?.message || "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/features")
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setTree(data || {}); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const projects = Object.keys(tree).sort();
  const features = project ? (tree[project] ?? []) : [];

  const counts =
    project && feature
      ? tree[project]?.find((f) => f.name === feature)?.counts
      : null;

  // Project-only is a real target, not an unset one — say so, rather than
  // telling a user who just created a project that nothing is selected.
  const label = project ? (feature ? `${project} / ${feature}` : project) : "Set target";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="rounded-full text-xs gap-1.5 px-2.5">
            <Target className="size-3.5" />
            <span className="text-muted-foreground">Target:</span>
            <span className="font-medium text-foreground">{label}</span>
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-2.5">
          <div>
            <label className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">
              Project
            </label>
            <Select
              value={project ?? ""}
              onValueChange={(v) => onChange(v || null, null)}
            >
              <SelectTrigger>
                <SelectValue placeholder={loading ? "Loading…" : "— project —"} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">
              Feature
            </label>
            <Select
              value={feature ?? ""}
              onValueChange={(v) => onChange(project, v || null)}
              disabled={!project}
            >
              <SelectTrigger>
                <SelectValue placeholder="— feature —" />
              </SelectTrigger>
              <SelectContent>
                {features.map((f) => (
                  <SelectItem key={f.name} value={f.name}>{f.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Create a new project / feature */}
          <div className="border-t pt-2.5">
            {!creating ? (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-1.5 text-xs text-scyne-ink"
                onClick={() => { setCreating(true); setCreateErr(null); }}
              >
                <Plus className="size-3.5" />
                New project / feature
              </Button>
            ) : (
              <div className="space-y-2">
                <input
                  autoFocus
                  value={newProject}
                  onChange={(e) => setNewProject(e.target.value)}
                  placeholder="Project (e.g. RTWSA)"
                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-scyne-ink/30"
                />
                <input
                  value={newFeature}
                  onChange={(e) => setNewFeature(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !busy) handleCreate(); }}
                  placeholder="Feature (e.g. return-to-work)"
                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-scyne-ink/30"
                />
                {createErr && <p className="text-[11px] text-red-600">{createErr}</p>}
                <div className="flex gap-2">
                  <Button size="sm" className="flex-1 text-xs" onClick={handleCreate} disabled={busy}>
                    {busy ? "Creating…" : "Create"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => { setCreating(false); setCreateErr(null); }}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                </div>
                <p className="text-[10.5px] text-muted-foreground">
                  Creates the empty folder structure. Attach files with the 📎 button afterwards.
                </p>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {counts && (
        <div className="flex items-center gap-1 flex-wrap">
          {Object.entries(counts).map(([k, n]) => (
            <Badge key={k} tone="neutral" size="sm" className="font-normal">
              {n} {k}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
