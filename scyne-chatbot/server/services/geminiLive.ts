import WebSocket from "ws";
import type { TranscriptEntry } from "./transcriptWriter.js";

const GEMINI_LIVE_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const CONNECTION_TIMEOUT_MS = 10000;
const MAX_AUDIO_BASE64_LENGTH = 200000; // ~150KB decoded per chunk

const MEETING_SYSTEM_PROMPT = `You are a passive, real-time meeting transcriber. You will receive audio of a conversation between two or more speakers.

Your only job is to transcribe what is said.

Rules:
- DO NOT respond, answer questions, give opinions, or add commentary of any kind.
- DO NOT acknowledge the speakers ("Sure", "Okay", "I understand", etc).
- Transcribe verbatim in English.
- Identify distinct speakers as "Speaker 1", "Speaker 2", … in the order they first speak; keep those labels consistent.
- When a speaker switches, start a new utterance prefixed with their label.
- Never produce audio output.`;

export type LiveEvent =
  | { type: "ready" }
  | { type: "transcript_delta"; speaker: string; text: string; timestampSec: number }
  | { type: "transcript_done"; speaker: string }
  | { type: "error"; message: string }
  | { type: "closed"; code?: number; reason?: string };

export interface MeetingSessionOptions {
  apiKey: string;
  model?: string;
  onEvent: (e: LiveEvent) => void;
}

/**
 * Bidirectional Gemini Live session adapted for passive meeting transcription.
 *
 * The browser pushes 16kHz mono PCM via `sendAudio(base64)`. We do not request
 * audio output from the model — only input transcription, which Gemini emits
 * as streaming `inputTranscription.text` chunks. Speaker diarisation is asked
 * for in the system prompt; we tag each chunk with the last-seen speaker label
 * extracted from the model's own output.
 */
export class MeetingSession {
  private ws: WebSocket | null = null;
  private isReady = false;
  private startTime: number | null = null;
  private entries: TranscriptEntry[] = [];
  private currentSpeaker: string | null = null;
  private currentBuffer = "";
  private onEvent: (e: LiveEvent) => void;
  private model: string;
  private apiKey: string;
  private closed = false;

  constructor(opts: MeetingSessionOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || process.env.GEMINI_LIVE_MODEL || "models/gemini-2.5-flash-native-audio-latest";
    this.onEvent = opts.onEvent;
  }

  start(): Promise<void> {
    this.startTime = Date.now();
    const url = `${GEMINI_LIVE_BASE}?key=${this.apiKey}`;

    return new Promise((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          this.ws?.close();
          this.ws = null;
          reject(new Error("Gemini Live connection timed out"));
        }
      }, CONNECTION_TIMEOUT_MS);

      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        const setupMessage = {
          setup: {
            model: this.model,
            generationConfig: {
              // We don't want spoken responses — text-only minimises Gemini chatter.
              // The system prompt also tells it not to speak.
              responseModalities: ["TEXT"],
            },
            systemInstruction: { parts: [{ text: MEETING_SYSTEM_PROMPT }] },
            inputAudioTranscription: {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                silenceDurationMs: 500,
              },
            },
          },
        };
        this.ws!.send(JSON.stringify(setupMessage));
        clearTimeout(timeout);
        resolved = true;
        resolve();
      });

      this.ws.on("message", (data) => this.handleMessage(data));

      this.ws.on("error", (err: Error) => {
        if (!resolved) {
          clearTimeout(timeout);
          reject(err);
        } else {
          this.onEvent({ type: "error", message: err.message });
        }
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        this.isReady = false;
        if (!this.closed) {
          this.onEvent({ type: "closed", code, reason: reason.toString() });
        }
      });
    });
  }

  /** Forward a base64 PCM chunk (16kHz mono LE) to Gemini. */
  sendAudio(base64Pcm: string): void {
    if (!this.isReady || !this.ws) return;
    if (typeof base64Pcm !== "string" || base64Pcm.length === 0) return;
    if (base64Pcm.length > MAX_AUDIO_BASE64_LENGTH) return;

    const message = {
      realtimeInput: {
        audio: { mimeType: "audio/pcm;rate=16000", data: base64Pcm },
      },
    };
    this.ws.send(JSON.stringify(message));
  }

  getEntries(): TranscriptEntry[] {
    // Flush any buffered current utterance into the entries list.
    this.finaliseCurrent();
    return this.entries;
  }

  getDurationSeconds(): number {
    if (!this.startTime) return 0;
    return Math.round((Date.now() - this.startTime) / 1000);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.finaliseCurrent();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.isReady = false;
  }

  private handleMessage(rawData: WebSocket.RawData): void {
    let msg: any;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    if (msg.setupComplete) {
      this.isReady = true;
      this.onEvent({ type: "ready" });
      return;
    }

    if (!msg.serverContent) return;

    if (msg.serverContent.inputTranscription?.text) {
      this.handleTranscriptionChunk(msg.serverContent.inputTranscription.text);
    }

    if (msg.serverContent.turnComplete) {
      this.finaliseCurrent();
    }
  }

  /**
   * Each Gemini chunk is partial. Speaker labels arrive embedded in the text
   * (e.g. "Speaker 1: hello", "Speaker 2: hi"). We detect a leading
   * "Speaker N:" prefix to swap speakers; otherwise the chunk is text for the
   * current speaker.
   */
  private handleTranscriptionChunk(chunk: string): void {
    const prefixRe = /^\s*(Speaker\s*\d+)\s*[:\-]\s*/i;
    let remaining = chunk;
    while (remaining.length > 0) {
      const m = remaining.match(prefixRe);
      if (m) {
        this.finaliseCurrent();
        this.currentSpeaker = `Speaker ${m[1].match(/\d+/)![0]}`;
        remaining = remaining.slice(m[0].length);
        continue;
      }
      // Take everything until the next potential "Speaker N:" prefix on its own.
      const nextPrefix = remaining.search(/\s+Speaker\s*\d+\s*[:\-]/i);
      const text = nextPrefix >= 0 ? remaining.slice(0, nextPrefix) : remaining;
      remaining = nextPrefix >= 0 ? remaining.slice(nextPrefix).replace(/^\s+/, "") : "";

      if (text.length > 0) {
        if (!this.currentSpeaker) this.currentSpeaker = "Speaker 1";
        this.currentBuffer += text;
        this.onEvent({
          type: "transcript_delta",
          speaker: this.currentSpeaker,
          text,
          timestampSec: this.getDurationSeconds(),
        });
      }
    }
  }

  private finaliseCurrent(): void {
    const text = this.currentBuffer.trim();
    if (text && this.currentSpeaker) {
      const elapsed = this.getDurationSeconds();
      this.entries.push({
        speaker: this.currentSpeaker,
        text,
        timestamp: `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`,
      });
      this.onEvent({ type: "transcript_done", speaker: this.currentSpeaker });
    }
    this.currentBuffer = "";
    // Keep currentSpeaker so subsequent chunks without a prefix attribute correctly.
  }
}
