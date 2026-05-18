import { useEffect, useState } from "react";
import { ChevronDown, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  refreshKey?: number;
}

export function TargetPicker({ project, feature, onChange, refreshKey }: Props) {
  const [tree, setTree] = useState<Record<string, Feature[]>>({});
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

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

  const label = project && feature ? `${project} / ${feature}` : "Set target";

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
