import path from "node:path";
import { CONVERTIBLE } from "../../../scripts/convert-to-md.mjs";

export type Subfolder = "sop" | "transcripts" | "notes" | "ui" | "template";
export type Hint = Subfolder | "audio" | undefined;

const DISK_SUBFOLDER: Record<Subfolder, string> = {
  sop: "SOP",
  transcripts: "Transcripts",
  notes: "Notes",
  ui: "UI",
  template: "templates",
};

export function requirementsDir(workspace: string, project: string, feature: string, sub: Subfolder): string {
  return `${workspace}/projects/${project}/${feature}/requirements/${DISK_SUBFOLDER[sub]}`;
}

export interface RouteResult {
  subfolder: Subfolder;
  savedName: string;
  /** True when the file is audio and needs transcription before landing. */
  isAudio: boolean;
  /** True when the heuristic couldn't decide and we need the caller to pick. */
  ambiguous: boolean;
}

const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".webm", ".ogg", ".flac"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
/**
 * Every document format the converter can read, so the name heuristics below
 * apply to all of them equally.
 *
 * This was `.docx/.pdf/.doc` written out by hand, which meant a PowerPoint
 * matched no branch at all and fell through to the catch-all as ambiguous —
 * even when its name said "SOP" in as many words. Taken from the converter so
 * a format becomes routable the moment it becomes readable.
 *
 * `.txt` and `.md` are deliberately NOT here: they are matched by NOTE_EXT
 * below, which is checked after this and files them without asking.
 */
const DOC_EXT: Set<string> = CONVERTIBLE;
const NOTE_EXT = new Set([".txt", ".md"]);

const SOP_HINT_RE = /(sop|policy|spec|requirement|domain)/i;
const TRANSCRIPT_HINT_RE = /(transcript|meeting|call|interview)/i;
const UI_HINT_RE = /(ui|screen|mock|wireframe|figma)/i;

/**
 * Decide which subfolder a freshly-uploaded file belongs in.
 *
 * Rules (deterministic, no LLM):
 *   - .png/.jpg/.jpeg/.gif/.webp           → ui/
 *   - .mp3/.wav/.m4a/.webm/.ogg/.flac      → audio (transcribe → transcripts/)
 *   - any convertible document containing
 *       "sop"|"policy"|"spec"|…            → sop/
 *   - any convertible document containing
 *       "transcript"|"meeting"|"call"      → transcripts/
 *   - any convertible document otherwise   → ambiguous (caller asks)
 *   - .txt/.md                              → notes/
 *
 * `hint` lets the caller force a subfolder when the user has already disambiguated.
 * `template` is reachable only via an explicit hint — it is never auto-inferred
 * (you never want a raw input auto-filed as a house-style template).
 */
export function routeFile(originalName: string, hint?: Hint): RouteResult {
  const ext = path.extname(originalName).toLowerCase();
  const base = path.basename(originalName, ext);

  if (hint && hint !== "audio") {
    return { subfolder: hint, savedName: originalName, isAudio: AUDIO_EXT.has(ext), ambiguous: false };
  }

  if (AUDIO_EXT.has(ext)) {
    return { subfolder: "transcripts", savedName: originalName, isAudio: true, ambiguous: false };
  }

  if (IMAGE_EXT.has(ext)) {
    const name = UI_HINT_RE.test(base) ? originalName : `ui-screen-${base}${ext}`;
    return { subfolder: "ui", savedName: name, isAudio: false, ambiguous: false };
  }

  if (DOC_EXT.has(ext)) {
    if (SOP_HINT_RE.test(base)) {
      return { subfolder: "sop", savedName: originalName, isAudio: false, ambiguous: false };
    }
    if (TRANSCRIPT_HINT_RE.test(base)) {
      return { subfolder: "transcripts", savedName: originalName, isAudio: false, ambiguous: false };
    }
    return { subfolder: "notes", savedName: originalName, isAudio: false, ambiguous: true };
  }

  if (NOTE_EXT.has(ext)) {
    return { subfolder: "notes", savedName: originalName, isAudio: false, ambiguous: false };
  }

  return { subfolder: "notes", savedName: originalName, isAudio: false, ambiguous: true };
}

/**
 * Pick a non-colliding filename inside `targetDir`. If `preferred` already exists,
 * append `-2`, `-3`, … before the extension until a free slot is found.
 */
export async function uniqueName(targetDir: string, preferred: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const ext = path.extname(preferred);
  const stem = path.basename(preferred, ext);
  let candidate = preferred;
  let n = 2;
  while (true) {
    try {
      await fs.access(path.join(targetDir, candidate));
      candidate = `${stem}-${n}${ext}`;
      n += 1;
    } catch {
      return candidate;
    }
  }
}
