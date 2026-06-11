import { useRef, useState } from "react";
import { FileText, Image as ImageIcon, Mic, Paperclip, Palette, Layout, StickyNote, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { uploadFile, type UploadFileSuccess, type UploadHint } from "../api";

interface Props {
  project: string | null;
  feature: string | null;
  onUploaded?: (result: UploadFileSuccess) => void;
  onError?: (message: string) => void;
}

interface Zone {
  hint: UploadHint;
  label: string;
  blurb: string;
  accept: string;
  icon: React.ReactNode;
}

const ZONES: Zone[] = [
  {
    hint: "ui",
    label: "UI screens",
    blurb: "Mockups & screenshots",
    accept: ".png,.jpg,.jpeg,.gif,.webp",
    icon: <ImageIcon className="size-5" />,
  },
  {
    hint: "transcripts",
    label: "Transcripts",
    blurb: "Meetings — docs or audio",
    accept: ".docx,.pdf,.doc,.txt,.md,.mp3,.wav,.m4a,.webm,.ogg,.flac",
    icon: <Mic className="size-5" />,
  },
  {
    hint: "sop",
    label: "SOP / policy",
    blurb: "SOP & policy docs",
    accept: ".docx,.pdf,.doc,.txt,.md",
    icon: <FileText className="size-5" />,
  },
  {
    hint: "notes",
    label: "Notes",
    blurb: "Anything else",
    accept: ".docx,.pdf,.doc,.txt,.md",
    icon: <StickyNote className="size-5" />,
  },
  // Design uploads land under projects/<p>/<f>/design/. The Developer (UI agent)
  // reads from here for visual direction; the BA ignores design/ entirely, so
  // these don't pollute the requirements flow.
  {
    hint: "style-guide",
    label: "Style guide",
    blurb: "Palette, typography, brand tokens",
    accept: ".png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.doc,.txt,.md",
    icon: <Palette className="size-5" />,
  },
  {
    hint: "example-screen",
    label: "Example screen",
    blurb: "Visual reference for the UI agent",
    accept: ".png,.jpg,.jpeg,.gif,.webp",
    icon: <Layout className="size-5" />,
  },
];

export function AttachmentButton({ project, feature, onUploaded, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const activeHint = useRef<UploadHint>("notes");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragZone, setDragZone] = useState<UploadHint | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  const ready = !!project && !!feature;
  const tooltip = !ready ? "Pick a project and feature first" : "Attach files";

  async function uploadOne(file: File, hint: UploadHint) {
    if (!project || !feature) return;
    setBusy(true);
    try {
      const result = await uploadFile(project, feature, file, hint);
      if ("ambiguous" in result && result.ambiguous) {
        // Shouldn't happen now that a hint is always supplied, but stay safe.
        onError?.(`Couldn't place ${file.name}.`);
        return;
      }
      const ok = result as UploadFileSuccess;
      onUploaded?.(ok);
      setRecent((r) => [`${ok.subfolder}/${ok.filename}`, ...r].slice(0, 6));
    } catch (e: any) {
      onError?.(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadMany(files: FileList | File[], hint: UploadHint) {
    for (const f of Array.from(files)) await uploadOne(f, hint);
  }

  function pickFor(hint: UploadHint, accept: string) {
    if (!ready || !inputRef.current) return;
    activeHint.current = hint;
    inputRef.current.accept = accept;
    inputRef.current.click();
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length) await uploadMany(files, activeHint.current);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <>
      <input ref={inputRef} type="file" multiple className="hidden" onChange={onPick} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={!ready}
            onClick={() => setOpen(true)}
            aria-label={tooltip}
          >
            <Paperclip />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add input files</DialogTitle>
            <DialogDescription>
              Choose where each file belongs in{" "}
              <span className="font-medium text-foreground">{project}/{feature}</span>. Click a tile or
              drop files onto it.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-2.5">
            {ZONES.map((z) => {
              const active = dragZone === z.hint;
              return (
                <button
                  key={z.hint}
                  type="button"
                  disabled={busy}
                  onClick={() => pickFor(z.hint, z.accept)}
                  onDragOver={(e) => { e.preventDefault(); setDragZone(z.hint); }}
                  onDragLeave={() => setDragZone((d) => (d === z.hint ? null : d))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragZone(null);
                    if (e.dataTransfer.files?.length) uploadMany(e.dataTransfer.files, z.hint);
                  }}
                  className={[
                    "flex flex-col items-start gap-1 rounded-lg border-2 border-dashed p-3 text-left transition-colors",
                    active
                      ? "border-scyne-ink bg-scyne-ink/5"
                      : "border-input hover:border-scyne-ink/50 hover:bg-muted/40",
                    busy ? "opacity-60" : "",
                  ].join(" ")}
                >
                  <span className="flex items-center gap-1.5 text-scyne-ink">
                    {z.icon}
                    <span className="text-sm font-semibold text-foreground">{z.label}</span>
                  </span>
                  <span className="text-[11px] text-muted-foreground">{z.blurb}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <UploadCloud className="size-3.5" />
            {busy ? "Uploading…" : "Audio dropped on Transcripts is auto-transcribed."}
          </div>

          {recent.length > 0 && (
            <div className="rounded-md bg-muted/50 p-2.5">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                Added this session
              </p>
              <ul className="space-y-0.5">
                {recent.map((r, i) => (
                  <li key={i} className="truncate font-mono text-[11px] text-foreground">{r}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end">
            <Button size="sm" onClick={() => setOpen(false)} disabled={busy}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
