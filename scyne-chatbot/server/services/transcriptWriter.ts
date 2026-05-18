import fs from "node:fs/promises";
import path from "node:path";
import { uniqueName, requirementsDir } from "./fileRouter.js";

export type TranscriptSource = "audio-upload" | "live-recording";

export interface TranscriptEntry {
  speaker: string;       // "Speaker 1", "Speaker 2", …
  text: string;
  timestamp?: string;    // "MM:SS" from session start, optional
}

export interface WriteTranscriptInput {
  project: string;
  feature: string;
  workspace: string;
  source: TranscriptSource;
  entries: TranscriptEntry[];
  durationSeconds?: number;
  originalFilename?: string;
}

export interface WriteTranscriptResult {
  absolutePath: string;
  relativePath: string;   // relative to workspace
  filename: string;
}

/**
 * Persist a diarised transcript into the feature's `transcripts/` folder as
 * markdown with a small YAML front-matter block. The BA agent reads anything
 * in that folder, so the filename pattern is the only contract.
 */
export async function writeTranscript(input: WriteTranscriptInput): Promise<WriteTranscriptResult> {
  const dir = requirementsDir(input.workspace, input.project, input.feature, "transcripts");
  await fs.mkdir(dir, { recursive: true });

  const preferred = `transcript-live.md`;
  const filename = await uniqueName(dir, preferred.replace("live", input.source === "audio-upload" ? "upload" : "live"));
  const abs = path.join(dir, filename);

  const lines: string[] = [];
  lines.push("---");
  lines.push(`source: ${input.source}`);
  lines.push(`captured_at: ${new Date().toISOString()}`);
  if (typeof input.durationSeconds === "number") lines.push(`duration_seconds: ${input.durationSeconds}`);
  if (input.originalFilename) lines.push(`original_filename: ${input.originalFilename}`);
  lines.push(`speakers: ${countDistinctSpeakers(input.entries)}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Meeting transcript`);
  lines.push("");
  for (const e of input.entries) {
    const ts = e.timestamp ? ` _(${e.timestamp})_` : "";
    lines.push(`**${e.speaker}:**${ts} ${e.text.trim()}`);
    lines.push("");
  }

  await fs.writeFile(abs, lines.join("\n"), "utf8");
  return {
    absolutePath: abs,
    relativePath: path.relative(input.workspace, abs),
    filename,
  };
}

function countDistinctSpeakers(entries: TranscriptEntry[]): number {
  const set = new Set<string>();
  for (const e of entries) set.add(e.speaker);
  return set.size;
}

/**
 * Parse Gemini's free-form diarised output ("Speaker 1: …\nSpeaker 2: …") into
 * structured entries. Lines that don't match the pattern get appended to the
 * previous entry as continuation text. Returns an empty array on no matches.
 */
export function parseDiarisedText(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const lineRe = /^\s*(Speaker\s*\d+|[A-Z][\w .'-]{0,40})\s*[:\-]\s*(.+)$/;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(lineRe);
    if (m) {
      entries.push({ speaker: normaliseSpeaker(m[1]), text: m[2].trim() });
    } else if (entries.length > 0) {
      entries[entries.length - 1].text += " " + line;
    } else {
      entries.push({ speaker: "Speaker 1", text: line });
    }
  }
  return entries;
}

function normaliseSpeaker(label: string): string {
  const m = label.match(/Speaker\s*(\d+)/i);
  if (m) return `Speaker ${m[1]}`;
  return label.trim();
}
