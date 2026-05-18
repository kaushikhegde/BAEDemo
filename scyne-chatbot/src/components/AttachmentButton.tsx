import { useRef, useState } from "react";
import { FileText, Mic, Paperclip, StickyNote } from "lucide-react";
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

interface PendingAmbiguous {
  file: File;
  originalName: string;
}

const HINT_OPTIONS: { value: UploadHint; label: string; icon: React.ReactNode }[] = [
  { value: "policy", label: "Policy / spec", icon: <FileText /> },
  { value: "transcripts", label: "Meeting transcript", icon: <Mic /> },
  { value: "notes", label: "Notes", icon: <StickyNote /> },
];

const ACCEPTED =
  ".docx,.pdf,.doc,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.mp3,.wav,.m4a,.webm,.ogg,.flac";

export function AttachmentButton({ project, feature, onUploaded, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAmbiguous | null>(null);

  const disabled = !project || !feature || busy;
  const tooltip = !project || !feature
    ? "Pick a project and feature first"
    : busy
    ? "Uploading…"
    : "Attach file";

  async function doUpload(file: File, hint?: UploadHint) {
    if (!project || !feature) return;
    setBusy(true);
    try {
      const result = await uploadFile(project, feature, file, hint);
      if ("ambiguous" in result && result.ambiguous) {
        setPending({ file, originalName: result.originalName });
      } else {
        onUploaded?.(result as UploadFileSuccess);
      }
    } catch (e: any) {
      onError?.(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) await doUpload(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function chooseHint(hint: UploadHint) {
    if (!pending) return;
    const f = pending.file;
    setPending(null);
    await doUpload(f, hint);
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="hidden"
        onChange={onPick}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            aria-label={tooltip}
          >
            <Paperclip />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>

      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Where does this file belong?</DialogTitle>
            <DialogDescription>
              Couldn't infer where{" "}
              <span className="font-medium text-foreground">{pending?.originalName}</span> should go.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {HINT_OPTIONS.map((o) => (
              <Button
                key={o.value}
                variant="outline"
                onClick={() => chooseHint(o.value)}
                className="justify-start"
              >
                {o.icon}
                {o.label}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
