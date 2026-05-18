import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { recordingSocketUrl } from "../api";

interface Props {
  project: string | null;
  feature: string | null;
  onSaved?: (info: { relativePath: string; filename: string; entryCount: number; durationSeconds: number }) => void;
  onError?: (message: string) => void;
}

interface LineDraft {
  speaker: string;
  text: string;
}

type Status = "idle" | "connecting" | "recording" | "saving" | "error";

const TARGET_SAMPLE_RATE = 16000;

export function RecordMeetingPanel({ project, feature, onSaved, onError }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [duration, setDuration] = useState(0);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const startTsRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);

  const disabled = !project || !feature || status === "connecting" || status === "saving";

  useEffect(() => {
    return () => { cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanup() {
    if (tickRef.current !== null) { clearInterval(tickRef.current); tickRef.current = null; }
    try { workletNodeRef.current?.disconnect(); } catch { /* ignore */ }
    try { sourceNodeRef.current?.disconnect(); } catch { /* ignore */ }
    workletNodeRef.current = null;
    sourceNodeRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      try { wsRef.current.close(); } catch { /* ignore */ }
    }
    wsRef.current = null;
  }

  async function start() {
    if (!project || !feature) return;
    setErrMsg(null);
    setLines([]);
    setDuration(0);
    setStatus("connecting");

    try {
      const ws = new WebSocket(recordingSocketUrl());
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.type === "ready") {
          startMicCapture().catch((err) => fail(err?.message ?? String(err)));
        } else if (msg.type === "transcript_delta") {
          setLines((prev) => mergeDelta(prev, msg.speaker, msg.text));
        } else if (msg.type === "saved") {
          setStatus("idle");
          cleanup();
          if (msg.empty) {
            setErrMsg("No speech detected — nothing saved.");
          } else {
            onSaved?.({
              relativePath: msg.relativePath,
              filename: msg.filename,
              entryCount: msg.entryCount,
              durationSeconds: msg.durationSeconds,
            });
          }
        } else if (msg.type === "error") {
          fail(msg.message || "Unknown server error");
        }
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "start", project, feature }));
      };

      ws.onerror = () => fail("WebSocket connection error");
      ws.onclose = () => {
        if (status === "recording" || status === "connecting") {
          fail("Recording connection closed unexpectedly");
        }
      };
    } catch (err: any) {
      fail(err?.message ?? String(err));
    }
  }

  async function startMicCapture() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    streamRef.current = stream;

    const AudioCtor: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    const audioCtx = new AudioCtor();
    audioCtxRef.current = audioCtx;
    await audioCtx.audioWorklet.addModule("/pcm-worklet.js");

    const source = audioCtx.createMediaStreamSource(stream);
    sourceNodeRef.current = source;

    const node = new AudioWorkletNode(audioCtx, "pcm-worklet");
    workletNodeRef.current = node;

    const sourceRate = audioCtx.sampleRate;
    let leftover: Float32Array = new Float32Array(0);

    node.port.onmessage = (ev) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const raw = ev.data as Float32Array;
      const frame = new Float32Array(raw.length);
      frame.set(raw);
      const combined = concatFloat32(leftover, frame);
      const { pcm16, remainder } = downsampleToInt16(combined, sourceRate, TARGET_SAMPLE_RATE);
      leftover = remainder;
      if (pcm16.byteLength === 0) return;
      const ab = new ArrayBuffer(pcm16.byteLength);
      new Int16Array(ab).set(pcm16);
      ws.send(JSON.stringify({ type: "audio", data: base64FromBuffer(ab) }));
    };

    source.connect(node);
    const silent = audioCtx.createGain();
    silent.gain.value = 0;
    node.connect(silent).connect(audioCtx.destination);

    startTsRef.current = Date.now();
    tickRef.current = window.setInterval(() => {
      setDuration(Math.round((Date.now() - (startTsRef.current ?? Date.now())) / 1000));
    }, 1000);
    setStatus("recording");
  }

  function stop() {
    if (status !== "recording") return;
    setStatus("saving");
    if (tickRef.current !== null) { clearInterval(tickRef.current); tickRef.current = null; }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    }
    try { workletNodeRef.current?.disconnect(); } catch { /* ignore */ }
    try { sourceNodeRef.current?.disconnect(); } catch { /* ignore */ }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  function fail(message: string) {
    setStatus("error");
    setErrMsg(message);
    onError?.(message);
    cleanup();
  }

  const tooltip = !project || !feature
    ? "Pick a project and feature first"
    : status === "recording"
    ? "Stop recording"
    : "Record meeting";

  const isRecording = status === "recording";
  const showTranscript = status === "recording" || lines.length > 0;

  return (
    <div className="relative">
      {isRecording ? (
        <Button
          variant="recording"
          size="default"
          onClick={stop}
          aria-label="Stop recording"
          className="font-mono"
        >
          <span className="size-1.5 rounded-full bg-current animate-pulse-dot" aria-hidden />
          <Square className="size-3 fill-current" />
          {fmtDuration(duration)}
        </Button>
      ) : status === "connecting" || status === "saving" ? (
        <Button variant="ghost" size="icon" disabled aria-label={status}>
          <Mic className="opacity-50" />
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled}
              onClick={start}
              aria-label={tooltip}
            >
              <Mic />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      )}

      {errMsg && (
        <span className="absolute top-full left-0 mt-1 text-xs text-danger-600 whitespace-nowrap">
          {errMsg}
        </span>
      )}

      {showTranscript && (
        <Card
          glass
          elevation={3}
          className="absolute bottom-full mb-3 right-0 w-[420px] max-w-[80vw] p-3 max-h-48 overflow-y-auto text-xs space-y-1 animate-slide-up"
        >
          <div className="text-[10.5px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
            Live transcript
          </div>
          {lines.length === 0 ? (
            <div className="text-muted-foreground italic">Listening…</div>
          ) : (
            lines.map((l, i) => (
              <div key={i} className="leading-relaxed">
                <span className="font-semibold text-scyne-ink-600">{l.speaker}:</span>{" "}
                <span className="text-slate-700">{l.text}</span>
              </div>
            ))
          )}
        </Card>
      )}
    </div>
  );
}

function mergeDelta(prev: LineDraft[], speaker: string, text: string): LineDraft[] {
  if (prev.length === 0 || prev[prev.length - 1].speaker !== speaker) {
    return [...prev, { speaker, text }];
  }
  const last = prev[prev.length - 1];
  return [...prev.slice(0, -1), { speaker, text: last.text + text }];
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function downsampleToInt16(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): { pcm16: Int16Array; remainder: Float32Array } {
  if (sourceRate === targetRate) {
    return { pcm16: floatToInt16(input), remainder: new Float32Array(0) };
  }
  const ratio = sourceRate / targetRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcStart = i * ratio;
    const srcEnd = (i + 1) * ratio;
    const startIdx = Math.floor(srcStart);
    const endIdx = Math.min(input.length, Math.ceil(srcEnd));
    let sum = 0;
    let n = 0;
    for (let j = startIdx; j < endIdx; j++) {
      sum += input[j];
      n++;
    }
    const avg = n > 0 ? sum / n : 0;
    const clamped = Math.max(-1, Math.min(1, avg));
    out[i] = Math.round(clamped * 32767);
  }
  const consumed = Math.floor(outLen * ratio);
  const tail = input.subarray(consumed);
  const remainder = new Float32Array(tail.length);
  remainder.set(tail);
  return { pcm16: out, remainder };
}

function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

function base64FromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}
