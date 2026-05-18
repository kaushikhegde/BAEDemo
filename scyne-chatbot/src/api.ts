export async function postChat(
  messages: { role: "user" | "assistant"; content: any }[],
  target?: { project: string | null; feature: string | null },
) {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, target }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function postTrigger(overrides: Record<string, string> = {}) {
  const r = await fetch("/api/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(overrides),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getStatus(issueId: string) {
  const r = await fetch(`/api/status/${issueId}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function hasPreview(project: string, feature: string): Promise<boolean> {
  const r = await fetch(`/api/preview/${encodeURIComponent(project)}/${encodeURIComponent(feature)}`);
  return r.ok;
}

export async function triggerUiBuild(project: string, feature: string) {
  const r = await fetch("/api/ui-agent/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, feature }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const err = new Error(body?.message || body?.error || `UI trigger failed (${r.status})`);
    (err as any).code = body?.error;
    throw err;
  }
  return r.json();
}

export async function postUiComment(issueId: string, body: string) {
  const r = await fetch("/api/ui-agent/comment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ issueId, body }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function approve(approvalId: string, note?: string) {
  const r = await fetch(`/api/approve/${approvalId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export type UploadHint = "policy" | "transcripts" | "notes" | "ui";

export interface UploadFileSuccess {
  kind: "file" | "transcript";
  subfolder: string;
  filename: string;
  relativePath: string;
  entryCount?: number;
  modelUsed?: string;
}

export interface UploadAmbiguous {
  ambiguous: true;
  originalName: string;
  message: string;
}

/**
 * Upload a single file into projects/<project>/<feature>/<auto-routed-subfolder>.
 * If the server can't infer where a .pdf/.docx belongs it returns an ambiguous
 * marker — call uploadFile again with the same blob and a chosen `hint`.
 */
export async function uploadFile(
  project: string,
  feature: string,
  file: File,
  hint?: UploadHint,
): Promise<UploadFileSuccess | UploadAmbiguous> {
  const form = new FormData();
  form.append("project", project);
  form.append("feature", feature);
  if (hint) form.append("hint", hint);
  form.append("file", file);
  const r = await fetch("/api/upload", { method: "POST", body: form });
  if (r.status === 409) {
    const body = await r.json();
    if (body?.error === "ambiguous_kind") {
      return { ambiguous: true, originalName: body.originalName, message: body.message };
    }
    throw new Error(body?.message || body?.error || `Upload failed (${r.status})`);
  }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export function recordingSocketUrl(): string {
  if (typeof window === "undefined") return "ws://127.0.0.1:4000/ws/record";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/record`;
}
