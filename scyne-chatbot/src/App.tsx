import { useEffect, useRef, useState } from "react";
import { ArrowUp, LogOut, RotateCcw, Sparkles } from "lucide-react";
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
import { PreviewPane } from "./components/PreviewPane";
import { Login, loadSession, clearSession, type LoginSession } from "./components/Login";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Skeleton } from "./components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { Textarea } from "./components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import type { UIMessage, StatusSnapshot } from "./types";
import { postChat, postTrigger, getStatus, approve, hasPreview, triggerUiBuild, postUiComment } from "./api";

function buildGreeting(resuming: boolean): UIMessage {
  return {
    id: "init",
    role: "assistant",
    text: resuming
      ? "G'day. I'm picking up where we left off — the workflow status is live on the right →"
      : "G'day. I'm Scyne AI Powered Social Insurance Delivery. How can I help today?",
  };
}

type ApiMsg = { role: "user" | "assistant"; content: any };

const SUGGESTED_PROMPTS = [
  "Generate stories from the latest transcripts",
  "Review the current product summary",
  "What features are in flight?",
];

export default function App() {
  // Gate everything behind the hardcoded demo login. Session survives refresh via localStorage.
  const [session, setSession] = useState<LoginSession | null>(() => loadSession());
  if (!session) {
    return <Login onAuthenticated={(s) => setSession(s)} />;
  }
  return (
    <AuthenticatedApp
      session={session}
      onLogout={() => { clearSession(); setSession(null); }}
    />
  );
}

function AuthenticatedApp({ session, onLogout }: { session: LoginSession; onLogout: () => void }) {
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
  // Target picker selection is persisted so iteration mode (chat → UI agent)
  // resumes after a refresh — without this, previewAvailable polling never
  // starts and the chat falls back to the LLM with no UI context.
  const [targetProject, setTargetProject] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try { return JSON.parse(window.localStorage.getItem("scyne_target") || "null")?.project ?? null; }
    catch { return null; }
  });
  const [targetFeature, setTargetFeature] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try { return JSON.parse(window.localStorage.getItem("scyne_target") || "null")?.feature ?? null; }
    catch { return null; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (targetProject && targetFeature) {
      window.localStorage.setItem("scyne_target", JSON.stringify({ project: targetProject, feature: targetFeature }));
    } else {
      window.localStorage.removeItem("scyne_target");
    }
  }, [targetProject, targetFeature]);
  const [featuresRefreshKey, setFeaturesRefreshKey] = useState(0);
  const [rightTab, setRightTab] = useState<"activity" | "ui">("activity");
  const [previewAvailable, setPreviewAvailable] = useState(false);
  const [pendingUiPrompt, setPendingUiPrompt] = useState<{ project: string; feature: string } | null>(null);
  const autoSwitchedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // When the BA flow has reached `done` AND a Confluence URL is live, surface a one-shot
  // CTA in the chat scroll asking the user if they want to kick off the UI build.
  // Dedupe via localStorage so we don't re-ask on refresh.
  useEffect(() => {
    if (!status || !targetProject || !targetFeature || !parentIssueId) return;
    const rootDone = status.flatIssues.length > 0 && status.flatIssues.every((i) => i.status === "done");
    const hasConfluence = (status.links?.confluence?.length ?? 0) > 0;
    if (!rootDone || !hasConfluence) return;
    const dedupeKey = `scyne_ui_prompted_for_${parentIssueId}`;
    if (typeof window !== "undefined" && window.localStorage.getItem(dedupeKey)) return;
    setPendingUiPrompt({ project: targetProject, feature: targetFeature });
  }, [status, targetProject, targetFeature, parentIssueId]);

  // Watch for the UI preview becoming available for the current target.
  // First time it appears, auto-switch the right pane to the UI tab.
  useEffect(() => {
    if (!targetProject || !targetFeature) {
      setPreviewAvailable(false);
      autoSwitchedRef.current = false;
      return;
    }
    let cancelled = false;
    const check = async () => {
      const ok = await hasPreview(targetProject, targetFeature);
      if (cancelled) return;
      setPreviewAvailable(ok);
      if (ok && !autoSwitchedRef.current) {
        autoSwitchedRef.current = true;
        setRightTab("ui");
      }
    };
    check();
    const id = setInterval(check, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [targetProject, targetFeature]);

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

    // When a live UI preview is up for the current target, route chat directly to the
    // UI agent's issue. The agent recognises three comment shapes:
    //   - `push to github <url>`  → push branch, then dispatch UX Auditor
    //   - `approve`               → dispatch UX Auditor against the local dev URL (no push)
    //   - `modify: <text>`        → iterate
    // We normalise free-form chat into one of those.
    if (previewAvailable && targetProject && targetFeature) {
      // Multiple `Build UI — …` issues may exist (re-triggers). Prefer the one that's
      // still active (not done) so comments actually wake the agent. Fall back to the
      // most recent done issue only if nothing is active.
      const buildUiIssues = (status?.flatIssues ?? []).filter((i) => i.title.startsWith("Build UI"));
      const activeUi = buildUiIssues.filter((i) => i.status !== "done");
      const uiChild = activeUi[activeUi.length - 1] ?? buildUiIssues[buildUiIssues.length - 1];
      if (!uiChild) {
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Couldn't find the active UI build issue yet — give the workflow a few seconds and try again.` }]);
        return;
      }
      const lower = userText.toLowerCase().trim();
      const APPROVE_RE = /^(approve|looks good|lgtm|ui is done|ui done|done|ship it|that's perfect|perfect|all good|that looks good|approved|run (the )?audit(or)?)\b/;
      let body: string;
      let assistantNote: string;
      if (lower.startsWith("push to github") || lower.startsWith("modify:")) {
        body = userText;
        assistantNote = lower.startsWith("push to github")
          ? `Pushing to GitHub and dispatching the UX Auditor…`
          : `Sent to the UI agent. The preview will refresh once it applies the change.`;
      } else if (APPROVE_RE.test(lower)) {
        body = "approve";
        assistantNote = `Approving and dispatching the UX Auditor against the local dev URL — no GitHub push.`;
      } else {
        body = `modify: ${userText}`;
        assistantNote = `Sent to the UI agent. The preview will refresh once it applies the change.`;
      }
      setBusy(true);
      try {
        await postUiComment(uiChild.id, body);
        setMessages((m) => [...m, {
          id: crypto.randomUUID(),
          role: "assistant",
          text: `${assistantNote}\n\n_Posted to **${uiChild.identifier}** (status: ${uiChild.status})._`,
        }]);
      } catch (e: any) {
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Couldn't reach the UI agent: ${e?.message ?? e}` }]);
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const resp = await postChat(nextHistory, { project: targetProject, feature: targetFeature });
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

      if (toolUse?.name === "set_target") {
        const args = toolUse.input as any;
        if (args?.project) setTargetProject(args.project);
        if (args?.feature) setTargetFeature(args.feature);
      } else if (toolUse?.name === "trigger_requirement_generation") {
        const args = toolUse.input as any;
        if (args?.project) setTargetProject(args.project);
        if (args?.feature) setTargetFeature(args.feature);
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Firing the workflow now for **${args.project}** / **${args.feature}**…` }]);
        const issue = await postTrigger(args || {});
        setParentIssueId(issue.id);
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Issue **${issue.identifier}** created and assigned to the Project Manager. Live progress on the right →` }]);
      } else if (toolUse?.name === "trigger_ui_build") {
        const args = toolUse.input as any;
        const proj = args?.project, feat = args?.feature;
        if (proj) setTargetProject(proj);
        if (feat) setTargetFeature(feat);
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Kicking off the UI agent for **${proj}** / **${feat}**…` }]);
        try {
          const issue = await triggerUiBuild(proj, feat);
          setParentIssueId(issue.id);
          setRightTab("ui");
          setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Issue **${issue.identifier}** created and assigned to the UI agent. The live preview will appear on the right once it scaffolds the app.` }]);
        } catch (e: any) {
          if (e?.code === "no_requirements") {
            setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `I can't find the requirements for **${proj}/${feat}** yet (no \`outputs/product-summary.md\`). Want me to run the BA flow first to generate them?` }]);
          } else {
            throw e;
          }
        }
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
    setTargetProject(null);
    setTargetFeature(null);
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (confirm(`Sign out of Scyne (${session.user})?`)) onLogout();
                  }}
                  aria-label={`Sign out (${session.user})`}
                >
                  <LogOut />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Sign out ({session.user})</TooltipContent>
            </Tooltip>
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
            {pendingUiPrompt && (
              <Card elevation={2} className="p-4 flex flex-col gap-3 bg-white/80">
                <div>
                  <div className="text-sm font-semibold text-foreground">Confluence + Jira are live.</div>
                  <div className="text-sm text-muted-foreground">
                    Want me to build the UI for <span className="font-medium">{pendingUiPrompt.project}/{pendingUiPrompt.feature}</span> from the design folder?
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={async () => {
                      const { project, feature } = pendingUiPrompt;
                      const dedupeKey = `scyne_ui_prompted_for_${parentIssueId ?? "anon"}`;
                      if (typeof window !== "undefined") window.localStorage.setItem(dedupeKey, "1");
                      setPendingUiPrompt(null);
                      setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", text: "Yes, build the UI." }]);
                      setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Kicking off the UI agent for **${project}** / **${feature}**…` }]);
                      try {
                        const issue = await triggerUiBuild(project, feature);
                        setParentIssueId(issue.id);
                        setRightTab("ui");
                        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Issue **${issue.identifier}** assigned to the UI agent. The live preview will land on the right once it scaffolds the app.` }]);
                      } catch (e: any) {
                        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Couldn't start the UI agent: ${e?.message ?? e}` }]);
                      }
                    }}
                  >
                    Yes, build the UI
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const dedupeKey = `scyne_ui_prompted_for_${parentIssueId ?? "anon"}`;
                      if (typeof window !== "undefined") window.localStorage.setItem(dedupeKey, "1");
                      setPendingUiPrompt(null);
                    }}
                  >
                    Not yet
                  </Button>
                </div>
              </Card>
            )}
          </div>
        </section>

        {/* Right: tabbed view — Activity (workflow status) | UI (live preview) */}
        <aside className="lg:col-span-5 flex flex-col gap-4">
          <Tabs value={rightTab} onValueChange={(v) => setRightTab(v as "activity" | "ui")} className="flex flex-col gap-2">
            <TabsList className="self-start">
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="ui" className="relative">
                UI
                {previewAvailable && rightTab !== "ui" && (
                  <span
                    aria-hidden
                    className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-emerald-500"
                  />
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="activity">
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
            </TabsContent>

            <TabsContent value="ui">
              {targetProject && targetFeature ? (
                <PreviewPane
                  project={targetProject}
                  feature={targetFeature}
                  onPush={async (repoUrl) => {
                    const uiChild = status?.flatIssues.find((i) => i.title.startsWith("Build UI"));
                    if (!uiChild) throw new Error("No active UI build issue found in the workflow tree.");
                    await postUiComment(uiChild.id, `push to github ${repoUrl}`);
                  }}
                />
              ) : (
                <Card
                  elevation={0}
                  className="p-8 text-center text-sm text-muted-foreground border-dashed bg-white/40"
                >
                  <Sparkles className="size-5 mx-auto mb-2 text-scyne-ink-500/60" />
                  <div className="font-medium text-foreground mb-1">No project selected</div>
                  <div>Pick a project / feature, then ask me to build the UI.</div>
                </Card>
              )}
              {targetProject && targetFeature && !previewAvailable && (
                <Card
                  elevation={0}
                  className="p-4 text-xs text-muted-foreground border-dashed bg-white/40"
                >
                  No preview yet for <span className="font-medium">{targetProject}/{targetFeature}</span>. Once the UI agent scaffolds the app, the live preview shows up here.
                </Card>
              )}
            </TabsContent>
          </Tabs>
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
