import { useEffect, useRef, useState } from "react";
import { ArrowUp, RotateCcw, Sparkles } from "lucide-react";
import { Header } from "./components/Header";
import { MessageBubble } from "./components/MessageBubble";
import { ProgressPanel } from "./components/ProgressPanel";
import { ApprovalCard } from "./components/ApprovalCard";
import { StagePill } from "./components/StagePill";
import { ActivityTimeline } from "./components/ActivityTimeline";
import { LinksPanel } from "./components/LinksPanel";
import { AttachmentButton } from "./components/AttachmentButton";
import { RecordMeetingPanel } from "./components/RecordMeetingPanel";
import { TargetPicker } from "./components/TargetPicker";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Skeleton } from "./components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { Textarea } from "./components/ui/textarea";
import type { UIMessage, StatusSnapshot } from "./types";
import { postChat, postTrigger, getStatus, approve } from "./api";

function buildGreeting(resuming: boolean): UIMessage {
  return {
    id: "init",
    role: "assistant",
    text: resuming
      ? "G'day. I'm picking up where we left off — the workflow status is live on the right →"
      : "G'day. I'm the Scyne AI Accelerated Software Delivery. How can I help today?",
  };
}

type ApiMsg = { role: "user" | "assistant"; content: any };

const SUGGESTED_PROMPTS = [
  "Generate stories from the latest transcripts",
  "Review the current product summary",
  "What features are in flight?",
];

export default function App() {
  const [messages, setMessages] = useState<UIMessage[]>(() => [
    buildGreeting(typeof window !== "undefined" && !!window.localStorage.getItem("scyne_parent_issue_id"))
  ]);
  const [apiHistory, setApiHistory] = useState<ApiMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [parentIssueId, setParentIssueIdRaw] = useState<string | null>(
    typeof window !== "undefined" ? window.localStorage.getItem("scyne_parent_issue_id") : null
  );
  const setParentIssueId = (id: string | null) => {
    setParentIssueIdRaw(id);
    if (typeof window !== "undefined") {
      if (id) window.localStorage.setItem("scyne_parent_issue_id", id);
      else window.localStorage.removeItem("scyne_parent_issue_id");
    }
  };
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [targetProject, setTargetProject] = useState<string | null>(null);
  const [targetFeature, setTargetFeature] = useState<string | null>(null);
  const [featuresRefreshKey, setFeaturesRefreshKey] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  // Polling: once we have a parent issue, poll status every 3s.
  // Agent comments stream into the right Activity panel only (deduped from chat).
  useEffect(() => {
    if (!parentIssueId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s: StatusSnapshot = await getStatus(parentIssueId);
        if (cancelled) return;
        setStatus(s);
      } catch (e) {
        console.error(e);
      }
    };
    tick();
    const h = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(h); };
  }, [parentIssueId]);

  async function send(text?: string) {
    const userText = (text ?? draft).trim();
    if (!userText || busy) return;
    setDraft("");
    const userMsg: UIMessage = { id: crypto.randomUUID(), role: "user", text: userText };
    setMessages((m) => [...m, userMsg]);
    const nextHistory: ApiMsg[] = [...apiHistory, { role: "user", content: userText }];
    setApiHistory(nextHistory);

    setBusy(true);
    try {
      const resp = await postChat(nextHistory);
      const blocks = resp.content as any[];
      let textOut = "";
      let toolUse: any = null;
      for (const b of blocks) {
        if (b.type === "text") textOut += b.text;
        if (b.type === "tool_use") toolUse = b;
      }
      if (textOut) {
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: textOut }]);
      }
      setApiHistory((h) => [...h, { role: "assistant", content: blocks }]);

      if (toolUse?.name === "trigger_requirement_generation") {
        const args = toolUse.input as any;
        if (args?.project) setTargetProject(args.project);
        if (args?.feature) setTargetFeature(args.feature);
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Firing the workflow now for **${args.project}** / **${args.feature}**…` }]);
        const issue = await postTrigger(args || {});
        setParentIssueId(issue.id);
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Issue **${issue.identifier}** created and assigned to the Project Manager. Live progress on the right →` }]);
      }
    } catch (e: any) {
      setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Hit an error: ${e?.message ?? e}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove(id: string) {
    await approve(id);
  }
  async function handleReject(id: string) {
    await fetch(`/api/reject/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  }

  function resetSession() {
    if (!confirm("Start a fresh conversation? This will detach the current workflow.")) return;
    setParentIssueId(null);
    setStatus(null);
    setMessages([buildGreeting(false)]);
    setApiHistory([]);
  }

  const pendingApprovals = status?.approvals.filter((a) => !a.status || a.status === "pending") ?? [];
  const resolvedApprovals = status?.approvals.filter((a) => a.status === "approved" || a.status === "rejected") ?? [];
  const showSuggestions = messages.length === 1 && !parentIssueId && !busy;
  const showSkeletons = !!parentIssueId && !status;

  return (
    <div className="min-h-full">
      <Header
        right={
          <>
            {status && <StagePill stage={status.stage} />}
            {parentIssueId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={resetSession}
                    aria-label="Start new session"
                  >
                    <RotateCcw />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New session</TooltipContent>
              </Tooltip>
            )}
          </>
        }
      />

      <main className="mx-auto max-w-[1440px] px-6 lg:px-8 pt-6 pb-44 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: chat */}
        <section className="lg:col-span-7 flex flex-col gap-4">
          <div
            ref={scrollRef}
            className="h-[calc(100vh-13rem)] overflow-y-auto scroll-smooth pr-2 space-y-4"
          >
            {showSuggestions && (
              <div className="flex items-start gap-3 mb-2">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-brand-gradient shadow-glow" />
                <div className="flex-1">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-scyne-ink-600 mb-2">
                    <Sparkles className="size-3.5" />
                    Suggested
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {SUGGESTED_PROMPTS.map((p) => (
                      <Button
                        key={p}
                        variant="outline"
                        size="sm"
                        onClick={() => send(p)}
                      >
                        {p}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {messages.map((m) => <MessageBubble key={m.id} m={m} />)}
            {pendingApprovals.map((a) => (
              <ApprovalCard key={a.id} approval={a} onApprove={handleApprove} onReject={handleReject} />
            ))}
          </div>
        </section>

        {/* Right: live workflow status */}
        <aside className="lg:col-span-5 flex flex-col gap-4">
          {showSkeletons ? (
            <>
              <Card elevation={1} className="p-4 space-y-2">
                <Skeleton className="h-4 w-20 mb-3" />
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-6 w-full" />)}
              </Card>
              <Card elevation={1} className="p-4 space-y-2">
                <Skeleton className="h-4 w-20 mb-3" />
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
              </Card>
            </>
          ) : status ? (
            <>
              <ProgressPanel items={status.flatIssues} />
              <ActivityTimeline items={status.activity} />
              {resolvedApprovals.map((a) => (
                <ApprovalCard
                  key={a.id}
                  approval={a}
                  onApprove={handleApprove}
                  onReject={handleReject}
                />
              ))}
              <LinksPanel links={status.links} />
            </>
          ) : (
            <Card
              elevation={0}
              className="p-8 text-center text-sm text-muted-foreground border-dashed bg-white/40"
            >
              <Sparkles className="size-5 mx-auto mb-2 text-scyne-ink-500/60" />
              <div className="font-medium text-foreground mb-1">No active workflow</div>
              <div>Workflow status will appear here once you fire a run.</div>
            </Card>
          )}
        </aside>
      </main>

      {/* Fixed composer dock — aligned under the chat column */}
      <div className="fixed inset-x-0 bottom-4 z-20 pointer-events-none">
        <div className="mx-auto max-w-[1440px] px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-12 gap-6">
          <Card
            glass
            elevation={3}
            className="lg:col-span-7 pointer-events-auto rounded-2xl p-3 flex flex-col gap-2 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background transition-shadow"
          >
          {/* Target row */}
          <div className="flex items-center justify-between gap-2 px-1">
            <TargetPicker
              project={targetProject}
              feature={targetFeature}
              refreshKey={featuresRefreshKey}
              onChange={(p, f) => { setTargetProject(p); setTargetFeature(f); }}
            />
          </div>

          {/* Textarea row */}
          <Textarea
            variant="borderless"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={busy}
            placeholder={busy ? "Working…" : "Tell me which project and feature, or answer the last question."}
            rows={2}
            aria-describedby="composer-hint"
            className="px-2"
          />

          {/* Action row */}
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-1">
              <AttachmentButton
                project={targetProject}
                feature={targetFeature}
                onUploaded={(r) => {
                  const desc = r.kind === "transcript"
                    ? `transcribed audio → **${r.relativePath}** (${r.entryCount} utterances)`
                    : `**${r.subfolder}/${r.filename}**`;
                  setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Uploaded ${desc}.` }]);
                  setFeaturesRefreshKey((k) => k + 1);
                }}
                onError={(msg) => setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Upload failed: ${msg}` }])}
              />
              <RecordMeetingPanel
                project={targetProject}
                feature={targetFeature}
                onSaved={(info) => {
                  setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Saved meeting transcript to **${info.relativePath}** (${info.entryCount} utterances · ${info.durationSeconds}s).` }]);
                  setFeaturesRefreshKey((k) => k + 1);
                }}
                onError={(msg) => setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Recording failed: ${msg}` }])}
              />
            </div>
            <div className="flex items-center gap-3">
              <span
                id="composer-hint"
                className="hidden sm:inline text-[11px] text-muted-foreground"
              >
                <kbd className="font-mono">Enter</kbd> to send · <kbd className="font-mono">Shift+Enter</kbd> newline
              </span>
              <Button
                variant="primary"
                size="default"
                onClick={() => send()}
                disabled={busy || !draft.trim()}
                aria-label="Send message"
              >
                <ArrowUp />
                Send
              </Button>
            </div>
          </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
