import fs from "node:fs/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import { parseDiarisedText, type TranscriptEntry } from "./transcriptWriter.js";

const TRANSCRIBE_MODEL =
  process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";

const DIARISATION_PROMPT = `You are a meeting transcriber. Transcribe the attached audio verbatim in English.

Format:
- One line per utterance.
- Prefix every utterance with "Speaker N:" where N is a stable 1-based index per distinct voice.
- Keep speakers consistent throughout the transcript.
- Do not summarise, paraphrase, or add commentary.
- If a speaker says something inaudible, write "[inaudible]".
- Do not add any preamble, headings, markdown, or trailing notes — only the diarised lines.`;

export interface TranscribeAudioResult {
  entries: TranscriptEntry[];
  rawText: string;
  modelUsed: string;
}

/**
 * Upload an audio file to the Gemini Files API, wait for it to become ACTIVE,
 * then ask a text model to produce a diarised transcript. Returns parsed
 * `Speaker N: text` entries plus the raw model output for debugging.
 */
export async function transcribeAudioFile(
  filePath: string,
  mimeType: string,
): Promise<TranscribeAudioResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const fileManager = new GoogleAIFileManager(apiKey);
  const upload = await fileManager.uploadFile(filePath, {
    mimeType,
    displayName: filePath.split("/").pop() ?? "audio",
  });

  // Wait for the file to leave PROCESSING. Gemini rejects fileUri use until ACTIVE.
  let file = upload.file;
  const startedAt = Date.now();
  while (file.state === FileState.PROCESSING) {
    if (Date.now() - startedAt > 5 * 60_000) {
      throw new Error("Gemini file processing timed out after 5 minutes");
    }
    await new Promise((r) => setTimeout(r, 1500));
    file = await fileManager.getFile(upload.file.name);
  }
  if (file.state !== FileState.ACTIVE) {
    throw new Error(`Gemini file upload failed with state ${file.state}`);
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: TRANSCRIBE_MODEL });

  const result = await model.generateContent([
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: DIARISATION_PROMPT },
  ]);

  const raw = result.response.text();
  const entries = parseDiarisedText(raw);

  // Best-effort cleanup — Gemini auto-deletes files after 48h so this is non-critical.
  fileManager.deleteFile(file.name).catch(() => undefined);

  return { entries, rawText: raw, modelUsed: TRANSCRIBE_MODEL };
}

/**
 * Convenience: write a Buffer to a temp path, run transcription, clean up.
 */
export async function transcribeAudioBuffer(
  buffer: Buffer,
  mimeType: string,
  filenameHint: string,
): Promise<TranscribeAudioResult> {
  const path = await import("node:path");
  const os = await import("node:os");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scyne-audio-"));
  const tmpPath = path.join(tmpDir, filenameHint);
  await fs.writeFile(tmpPath, buffer);
  try {
    return await transcribeAudioFile(tmpPath, mimeType);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
