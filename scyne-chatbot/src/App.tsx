import { useEffect, useRef, useState } from "react";
import { ArrowUp, Eye, History as HistoryIcon, LayoutDashboard, LogOut, RotateCcw, Sparkles } from "lucide-react";
import { Header } from "./components/Header";
import { HistoryView } from "./components/HistoryView";
import { MessageBubble } from "./components/MessageBubble";
import { ProgressPanel } from "./components/ProgressPanel";
import { ApprovalCard } from "./components/ApprovalCard";
import { StagePill } from "./components/StagePill";
import { ActivityTimeline } from "./components/ActivityTimeline";
import { LiveTranscript } from "./components/LiveTranscript";
import { LinksPanel } from "./components/LinksPanel";
import { RunsPanel } from "./components/RunsPanel";
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
import { postChat, postTrigger, getStatus, getRuns, approve, requestChanges, hasPreview, triggerUiBuild, triggerDataModel, triggerSolutionDesign, postUiComment, type RunSummary } from "./api";

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

// Chat transcript persistence. Only `parentIssueId` used to survive a refresh, so
// the conversation vanished on reload ("chat empties"). Persist the rendered
// messages + the LLM history so a refresh resumes the conversation, not just the
// right-hand workflow panel (which already rehydrates from /api/status).
const MESSAGES_KEY = "scyne_chat_messages";
const HISTORY_KEY = "scyne_chat_history";

function loadMessages(): UIMessage[] {
  if (typeof window === "undefined") return [buildGreeting(false)];
  const resuming = !!window.localStorage.getItem("scyne_parent_issue_id");
  try {
    const raw = window.localStorage.getItem(MESSAGES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as UIMessage[];
    }
  } catch { /* corrupt store — fall back to a fresh greeting */ }
  return [buildGreeting(resuming)];
}

function loadHistory(): ApiMsg[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as ApiMsg[];
    }
  } catch { /* ignore */ }
  return [];
}

function clearChatPersistence() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(MESSAGES_KEY);
  window.localStorage.removeItem(HISTORY_KEY);
}

export default function App() {
  // Gate everything behind the hardcoded demo login. Session survives refresh via localStorage.
  const [session, setSession] = useState<LoginSession | null>(() => loadSession());
  if (!session) {
    return <Login onAuthenticated={(s) => setSession(s)} />;
  }
  return (
    <AuthenticatedApp
      session={session}
      onLogout={() => { clearSession(); clearChatPersistence(); setSession(null); }}
    />
  );
}

function AuthenticatedApp({ session, onLogout }: { session: LoginSession; onLogout: () => void }) {
  const [messages, setMessages] = useState<UIMessage[]>(() => loadMessages());
  const [apiHistory, setApiHistory] = useState<ApiMsg[]>(() => loadHistory());
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
  // Tracks a failing /api/status poll so the right panel can show an error +
  // auto-retry note instead of sitting on skeletons forever (e.g. when the
  // backend or Paperclip isn't reachable right after a refresh).
  const [statusError, setStatusError] = useState<string | null>(null);
  // Top-level view: the live workspace (chat + workflow) vs the History page.
  const [view, setView] = useState<"workspace" | "history">("workspace");
  // Compact agent run summaries for the Activity panel.
  const [runs, setRuns] = useState<RunSummary[]>([]);
  // Whether the Agent Runs panel (beside Workflow) is shown. Remembered across refreshes.
  const [showAgentRuns, setShowAgentRuns] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("scyne_show_agent_runs") !== "0";
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("scyne_show_agent_runs", showAgentRuns ? "1" : "0");
  }, [showAgentRuns]);
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
  // Activity panel inner toggle: comments timeline vs live agent transcript.
  // Persisted so a refresh keeps whichever view the user was on.
  const [activityView, setActivityView] = useState<"comments" | "transcript">(() => {
    try {
      const v = window.localStorage.getItem("scyne_activity_view");
      return v === "transcript" ? "transcript" : "comments";
    } catch { return "comments"; }
  });
  useEffect(() => {
    try { window.localStorage.setItem("scyne_activity_view", activityView); } catch {}
  }, [activityView]);
  const [previewAvailable, setPreviewAvailable] = useState(false);
  const [pendingUiPrompt, setPendingUiPrompt] = useState<{ project: string; feature: string; headline: string; dedupeKey: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Remember the last Build UI run this browser triggered, so the chat's
  // modify/approve/push path can find it again after parentIssueId moves on to
  // a pipeline run (data model / solution design) and back.
  const rememberUiIssue = (issueId: string) => {
    if (typeof window !== "undefined") window.localStorage.setItem("scyne_ui_issue_id", issueId);
  };

  // Surface a one-shot "build the UI?" CTA in the chat scroll at the two natural
  // entry points: right after the REQUIREMENTS run completes (Confluence + Jira
  // live), and again after the SOLUTION DESIGN run completes if the UI was
  // skipped earlier — so the user can do requirements → data model → solution
  // design and still come back to the UI from the chat. Each entry point has its
  // own localStorage dedupe key so declining the first offer doesn't suppress
  // the second.
  useEffect(() => {
    if (!status || !targetProject || !targetFeature || !parentIssueId) return;
    const rootTitle = status.flatIssues[0]?.title ?? "";
    const isRequirementsRun = rootTitle.startsWith("Generate requirements");
    const isSolutionDesignRun = rootTitle.startsWith("Generate solution design");
    if (!isRequirementsRun && !isSolutionDesignRun) return;
    const rootDone = status.flatIssues.length > 0 && status.flatIssues.every((i) => i.status === "done");
    const hasConfluence = (status.links?.confluence?.length ?? 0) > 0;
    if (!rootDone || !hasConfluence) return;
    // After the solution design, only re-offer if no UI app exists yet.
    if (isSolutionDesignRun && previewAvailable) return;
    // Dedupe per project/feature, not per parent issue, so clicking "Yes, build the UI"
    // (which swaps parentIssueId to the new Build UI issue) doesn't immediately re-trigger
    // the prompt against the stale "done" status snapshot.
    const dedupeKey = isRequirementsRun
      ? `scyne_ui_prompted_for_${targetProject}__${targetFeature}`
      : `scyne_ui_prompted_after_sd_${targetProject}__${targetFeature}`;
    if (typeof window !== "undefined" && window.localStorage.getItem(dedupeKey)) return;
    setPendingUiPrompt({
      project: targetProject,
      feature: targetFeature,
      headline: isRequirementsRun ? "Confluence + Jira are live." : "Solution design is published — the pipeline is complete.",
      dedupeKey,
    });
  }, [status, targetProject, targetFeature, parentIssueId, previewAvailable]);

  // Watch for the UI preview becoming available for the current target.
  // Don't auto-switch tabs — the green dot on the UI tab signals it's ready;
  // the user clicks over when they want to see it.
  useEffect(() => {
    if (!targetProject || !targetFeature) {
      setPreviewAvailable(false);
      return;
    }
    let cancelled = false;
    const check = async () => {
      const ok = await hasPreview(targetProject, targetFeature);
      if (cancelled) return;
      setPreviewAvailable(ok);
    };
    check();
    const id = setInterval(check, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [targetProject, targetFeature]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  // Persist the chat transcript + LLM history so a refresh resumes the
  // conversation. The right-hand workflow panel rehydrates separately from
  // /api/status via the polling effect below.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages)); } catch { /* quota */ }
  }, [messages]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(apiHistory)); } catch { /* quota */ }
  }, [apiHistory]);

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
        setStatusError(null);
        // Best-effort: refresh the compact agent run summaries alongside status.
        getRuns(parentIssueId).then((r) => { if (!cancelled) setRuns(r); }).catch(() => {});
      } catch (e: any) {
        if (cancelled) return;
        // Keep the last good status on screen if we had one; otherwise this lets
        // the panel show an error instead of skeletons forever. Polling retries.
        setStatusError(e?.message ? String(e.message).slice(0, 200) : "Couldn't reach the workflow service.");
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
      // The LLM decides intent. When a UI preview is live we tell it so (uiContext),
      // and it will call `comment_on_ui_build` for change/approve/push requests while
      // answering questions normally — no blunt "everything goes to the ticket" gate.
      const uiContext = previewAvailable && targetProject && targetFeature
        ? { active: true, project: targetProject, feature: targetFeature }
        : undefined;
      const resp = await postChat(nextHistory, { project: targetProject, feature: targetFeature }, uiContext);
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
        const proj = args?.project ? String(args.project) : null;
        const feat = args?.feature ? String(args.feature) : null;
        if (proj) setTargetProject(proj);
        // Picking a new project without a feature should clear the stale feature
        // so the picker doesn't show e.g. "SADA / return-to-work" mid-flow.
        setTargetFeature(feat);
        // If Gemini emitted only the tool call with no accompanying text, the
        // chat would go silent — synthesise a short confirmation so the user
        // sees their selection landed.
        if (!textOut && proj) {
          const label = feat ? `**${proj} / ${feat}**` : `**${proj}**`;
          setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Target set to ${label}.` }]);
        }
      } else if (toolUse?.name === "trigger_requirement_generation") {
        const args = toolUse.input as any;
        if (args?.project) setTargetProject(args.project);
        if (args?.feature) setTargetFeature(args.feature);
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Firing the workflow now for **${args.project}** / **${args.feature}**…` }]);
        try {
          const issue = await postTrigger(args || {});
          setParentIssueId(issue.id);
          setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Issue **${issue.identifier}** created and assigned to the Delivery Lead. Live progress on the right →` }]);
        } catch (e: any) {
          if (e?.code === "missing_inputs") {
            const folders = Array.isArray(e.emptyFolders) ? e.emptyFolders.join(", ") : "some required folders";
            setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `I can't start that yet — these input folders are empty for **${args.project}/${args.feature}**: **${folders}**. Upload at least one file to each (use the 📎 attach button below), then say "go".` }]);
          } else {
            throw e;
          }
        }
      } else if (toolUse?.name === "trigger_ui_build") {
        const args = toolUse.input as any;
        const proj = args?.project, feat = args?.feature;
        if (proj) setTargetProject(proj);
        if (feat) setTargetFeature(feat);
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Kicking off the UI agent for **${proj}** / **${feat}**…` }]);
        try {
          // Pre-set both per-project dedupe flags so neither "build UI?" prompt card
          // (post-requirements or post-solution-design) pops against a stale snapshot.
          if (typeof window !== "undefined" && proj && feat) {
            window.localStorage.setItem(`scyne_ui_prompted_for_${proj}__${feat}`, "1");
            window.localStorage.setItem(`scyne_ui_prompted_after_sd_${proj}__${feat}`, "1");
          }
          const issue = await triggerUiBuild(proj, feat);
          rememberUiIssue(issue.id);
          setParentIssueId(issue.id);
          setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Issue **${issue.identifier}** created and assigned to the UI agent. The live preview will appear on the right once it scaffolds the app.` }]);
        } catch (e: any) {
          if (e?.code === "no_requirements") {
            setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `I can't find the requirements for **${proj}/${feat}** yet (no \`outputs/product-summary.md\`). Want me to run the BA flow first to generate them?` }]);
          } else {
            throw e;
          }
        }
      } else if (toolUse?.name === "trigger_data_model" || toolUse?.name === "trigger_solution_design") {
        // The two downstream pipeline stages share one trigger shape — only the
        // worker label, API call, and prerequisite-gate message differ. Keeping
        // them in one table prevents the copies drifting (e.g. a gate-code
        // mismatch that would fall through to the raw error path).
        const PIPELINE_STAGES = {
          trigger_data_model: {
            worker: "Data Modeler",
            fire: triggerDataModel,
            gateCode: "no_product_summary",
            gateMessage: (p: string, f: string) => `I can't build the data model yet — there's no product summary for **${p}/${f}**. Want me to generate the requirements first?`,
          },
          trigger_solution_design: {
            worker: "Architecture Lead",
            fire: triggerSolutionDesign,
            gateCode: "no_data_model",
            gateMessage: (p: string, f: string) => `I can't build the solution design yet — there's no data model for **${p}/${f}**. Want me to generate the data model first?`,
          },
        } as const;
        const stage = PIPELINE_STAGES[toolUse.name as keyof typeof PIPELINE_STAGES];
        const args = toolUse.input as any;
        const proj = args?.project, feat = args?.feature;
        if (proj) setTargetProject(proj);
        if (feat) setTargetFeature(feat);
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Kicking off the ${stage.worker} for **${proj}** / **${feat}**…` }]);
        try {
          const issue = await stage.fire(proj, feat);
          setParentIssueId(issue.id);
          setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Issue **${issue.identifier}** created and assigned to the Delivery Lead → ${stage.worker}. Live progress on the right →` }]);
        } catch (e: any) {
          if (e?.code === stage.gateCode) {
            setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: stage.gateMessage(proj, feat) }]);
          } else {
            throw e;
          }
        }
      } else if (toolUse?.name === "control_dev_server") {
        const args = toolUse.input as any;
        const action = args?.action === "stop" ? "stop" : "start";
        const proj = String(args?.project || targetProject || "").trim();
        const feat = String(args?.feature || targetFeature || "").trim();
        if (!proj || !feat) {
          setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `I need a project + feature to ${action} the dev server — pick one with the target picker, or tell me which.` }]);
        } else {
          setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: action === "start" ? `Starting the preview for **${proj}/${feat}**… (idempotent — no-op if already running).` : `Stopping the preview for **${proj}/${feat}**…` }]);
          try {
            const r = await fetch(`/api/preview/${encodeURIComponent(proj)}/${encodeURIComponent(feat)}/${action}`, { method: "POST" });
            const body = await r.json();
            if (!r.ok) throw new Error(body?.message || body?.error || `HTTP ${r.status}`);
            const entry = body?.entry || {};
            const summary = action === "start"
              ? `Preview is up at **${entry.devUrl ?? "unknown URL"}** (pid ${entry.pid ?? "?"}, port ${entry.port ?? "?"}).`
              : `Preview stopped. The registry entry is preserved — say "start the UI" to bring it back up on the same port.`;
            setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: summary }]);
          } catch (e: any) {
            setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Couldn't ${action} the dev server: ${e?.message ?? e}` }]);
          }
        }
      } else if (toolUse?.name === "comment_on_ui_build") {
        // LLM classified this message as a UI change/approve/push. Resolve the active
        // Build UI issue and post the normalised comment shape the Developer expects.
        const args = toolUse.input as any;
        const kind = String(args?.kind || "modify");
        const instruction = String(args?.instruction || userText);
        const repoUrl = String(args?.repo_url || "");
        let buildUiIssues = (status?.flatIssues ?? []).filter((i) => i.title.startsWith("Build UI"));
        if (buildUiIssues.length === 0) {
          // The chat has moved on to another flow (data model / solution design),
          // so the polled tree has no Build UI issue. Fall back to the last Build
          // UI run this browser triggered and look the child up in ITS tree —
          // the UI preview stays alive across pipeline detours, so "come back to
          // the UI" keeps working.
          const storedId = typeof window !== "undefined" ? window.localStorage.getItem("scyne_ui_issue_id") : null;
          if (storedId) {
            try {
              const uiStatus: StatusSnapshot = await getStatus(storedId);
              buildUiIssues = (uiStatus.flatIssues ?? []).filter((i) => i.title.startsWith("Build UI"));
            } catch { /* fall through to the not-found message */ }
          }
        }
        const activeUi = buildUiIssues.filter((i) => i.status !== "done");
        const uiChild = activeUi[activeUi.length - 1] ?? buildUiIssues[buildUiIssues.length - 1];
        if (!uiChild) {
          setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `I couldn't find the active UI build issue yet — give it a few seconds and try again.` }]);
        } else {
          const body = kind === "approve" ? "approve"
            : kind === "push" ? `push to github ${repoUrl}`.trim()
            : `modify: ${instruction}`;
          const note = kind === "approve" ? `Approving and dispatching the UX Auditor against the local dev URL.`
            : kind === "push" ? `Pushing to GitHub and dispatching the UX Auditor…`
            : `Sent to the UI agent — the preview refreshes once it applies the change.`;
          try {
            await postUiComment(uiChild.id, body);
            setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `${note}\n\n_Posted to **${uiChild.identifier}**._` }]);
          } catch (e: any) {
            setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Couldn't reach the UI agent: ${e?.message ?? e}` }]);
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
    try {
      // Pass the parent issue so the server can auto-create the Jira project +
      // Confluence space (if configured) before resolving the gate.
      await approve(id, parentIssueId ?? undefined);
    } catch (e: any) {
      setMessages((m) => [...m, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: e?.code === "provision_failed"
          ? `I held off approving — couldn't prepare the Atlassian targets:\n\n> ${e.message}\n\nFix the project/space (or its permissions) and approve again.`
          : `Approval failed: ${e?.message ?? e}`,
      }]);
    }
  }
  // Reviewer wasn't happy: send their notes to the BA, which regenerates and raises
  // a fresh gate. We optimistically surface it in the chat so the loop is visible.
  async function handleRequestChanges(id: string, issueId: string, feedback: string) {
    await requestChanges(id, issueId, feedback);
    setMessages((m) => [...m, {
      id: crypto.randomUUID(),
      role: "assistant",
      text: `Sent your changes back to the agent:\n\n> ${feedback}\n\nIt’ll regenerate and raise a fresh approval here.`,
    }]);
  }

  function resetSession() {
    if (!confirm("Start a fresh conversation? This will detach the current workflow.")) return;
    setParentIssueId(null);
    setStatus(null);
    setStatusError(null);
    setRuns([]);
    clearChatPersistence();
    if (typeof window !== "undefined") window.localStorage.removeItem("scyne_ui_issue_id");
    setMessages([buildGreeting(false)]);
    setApiHistory([]);
    setTargetProject(null);
    setTargetFeature(null);
  }

  // "live" gates: awaiting the human (pending) or being regenerated after feedback
  // (revision_requested). Show the "Regenerating…" card only while there's no fresh
  // pending gate yet for that issue — once the BA raises the new gate, drop the stale one.
  const allApprovals = status?.approvals ?? [];
  const issuesWithPending = new Set(allApprovals.filter((a) => !a.status || a.status === "pending").map((a) => a.issueId));
  const pendingApprovals = allApprovals.filter((a) => {
    if (!a.status || a.status === "pending") return true;
    if (a.status === "revision_requested") return !issuesWithPending.has(a.issueId);
    return false;
  });
  // We only render approval cards that still need attention here. `approved`
  // and `rejected` carry no new info post-resolution (the StagePill below the
  // chat already reflects the new workflow state, and the chat shows the user's
  // own click). Keeping those badges pinned at the bottom of the activity panel
  // visually overlapped the Live Transcript / Activity feed — drop them.
  const resolvedApprovals = status?.approvals.filter((a) => a.status === "revision_requested") ?? [];
  const showSuggestions = messages.length === 1 && !parentIssueId && !busy;
  // Skeletons only on the very first load (no status yet, no error). Once a poll
  // has errored we show the error card instead so the panel never gets stuck.
  const showSkeletons = !!parentIssueId && !status && !statusError;

  return (
    <div className="min-h-full">
      <Header
        right={
          <>
            {view === "workspace" && status && <StagePill stage={status.stage} />}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setView((v) => (v === "history" ? "workspace" : "history"))}
                  aria-label={view === "history" ? "Back to workspace" : "View completed tasks"}
                >
                  {view === "history" ? <LayoutDashboard /> : <HistoryIcon />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{view === "history" ? "Back to workspace" : "Completed tasks"}</TooltipContent>
            </Tooltip>
            {view === "workspace" && parentIssueId && (
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

      {view === "history" ? (
        <main className="px-6 lg:px-8 pt-6 pb-10">
          <HistoryView />
        </main>
      ) : (
      <>
      <main className="px-6 lg:px-8 pt-6 pb-44 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: chat */}
        <section className="lg:col-span-4 flex flex-col gap-4">
          <div
            ref={scrollRef}
            className="h-[calc(100vh-16rem)] overflow-y-auto scroll-smooth pr-2 space-y-4"
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
              <ApprovalCard key={a.id} approval={a} project={targetProject} feature={targetFeature} onApprove={handleApprove} onRequestChanges={handleRequestChanges} />
            ))}
            {status && (status.links.confluence.length > 0 || status.links.jira.length > 0) && (
              <LinksPanel links={status.links} />
            )}
            {pendingUiPrompt && (
              <Card elevation={2} className="p-4 flex flex-col gap-3 bg-white/80">
                <div>
                  <div className="text-sm font-semibold text-foreground">{pendingUiPrompt.headline}</div>
                  <div className="text-sm text-muted-foreground">
                    Want me to build the UI for <span className="font-medium">{pendingUiPrompt.project}/{pendingUiPrompt.feature}</span> from the design folder?
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={async () => {
                      const { project, feature, dedupeKey } = pendingUiPrompt;
                      if (typeof window !== "undefined") window.localStorage.setItem(dedupeKey, "1");
                      setPendingUiPrompt(null);
                      setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", text: "Yes, build the UI." }]);
                      setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: `Kicking off the UI agent for **${project}** / **${feature}**…` }]);
                      try {
                        const issue = await triggerUiBuild(project, feature);
                        rememberUiIssue(issue.id);
                        setParentIssueId(issue.id);
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
                      const { dedupeKey } = pendingUiPrompt;
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
        <aside className="lg:col-span-8 flex flex-col gap-4 lg:h-[calc(100vh-13rem)] min-h-0">
          <Tabs value={rightTab} onValueChange={(v) => setRightTab(v as "activity" | "ui")} className="flex flex-col gap-2 flex-1 min-h-0">
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

            {/* Panel matches the chat box height; each region scrolls its own content. */}
            <TabsContent value="activity" className="flex-1 min-h-0 flex flex-col">
              {showSkeletons ? (
                <>
                  <Card elevation={1} className="p-4 space-y-2">
                    <Skeleton className="h-4 w-20 mb-3" />
                    {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-6 w-full" />)}
                  </Card>
                  <Card elevation={1} className="p-4 space-y-2 mt-4">
                    <Skeleton className="h-4 w-20 mb-3" />
                    {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
                  </Card>
                </>
              ) : status ? (
                <div className="flex flex-col gap-4 flex-1 min-h-0">
                  {statusError && (
                    <Card elevation={0} className="p-3 text-xs text-amber-700 border-amber-200 bg-amber-50/70 shrink-0">
                      Reconnecting to the workflow service… showing the last known status.
                    </Card>
                  )}
                  {/* Workflow + Agent Runs side by side, equal fixed height; each scrolls internally. */}
                  <div className={`grid gap-4 shrink-0 h-56 ${showAgentRuns && runs.length > 0 ? "lg:grid-cols-2" : "grid-cols-1"}`}>
                    <ProgressPanel items={status.flatIssues} />
                    {showAgentRuns && runs.length > 0 && (
                      <RunsPanel runs={runs} onHide={() => setShowAgentRuns(false)} />
                    )}
                  </div>
                  {!showAgentRuns && runs.length > 0 && (
                    <button
                      onClick={() => setShowAgentRuns(true)}
                      className="self-start inline-flex items-center gap-1 text-xs font-medium text-scyne-ink-600 hover:text-scyne-ink-700 transition-colors shrink-0"
                    >
                      <Eye className="size-3.5" /> Show agent runs ({runs.length})
                    </button>
                  )}
                  {/* Activity view toggle: comments timeline vs live transcript */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => setActivityView("comments")}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                        activityView === "comments"
                          ? "bg-scyne-ink-100 text-scyne-ink-700"
                          : "text-scyne-ink-500 hover:text-scyne-ink-700 hover:bg-scyne-ink-50"
                      }`}
                    >
                      Activity
                    </button>
                    <button
                      type="button"
                      onClick={() => setActivityView("transcript")}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                        activityView === "transcript"
                          ? "bg-scyne-ink-100 text-scyne-ink-700"
                          : "text-scyne-ink-500 hover:text-scyne-ink-700 hover:bg-scyne-ink-50"
                      }`}
                    >
                      Live Transcript
                    </button>
                  </div>
                  {/* Render both panes always; hide the inactive one with CSS so its
                      internal state (LiveTranscript's per-run cache, scroll position,
                      etc.) survives tab switches instead of being destroyed on unmount. */}
                  <div className={`flex-1 min-h-0 flex flex-col ${activityView === "comments" ? "" : "hidden"}`}>
                    <ActivityTimeline items={status.activity} />
                  </div>
                  <div className={`flex-1 min-h-0 flex flex-col ${activityView === "transcript" ? "" : "hidden"}`}>
                    <LiveTranscript parentIssueId={parentIssueId} />
                  </div>
                  {resolvedApprovals.map((a) => (
                    <div key={a.id} className="shrink-0">
                      <ApprovalCard
                        approval={a}
                        project={targetProject}
                        feature={targetFeature}
                        onApprove={handleApprove}
                        onRequestChanges={handleRequestChanges}
                      />
                    </div>
                  ))}
                  {/* Published links live in the left chat now — no duplicate here, so
                      the Activity list keeps its full height. */}
                </div>
              ) : statusError && parentIssueId ? (
                <Card
                  elevation={0}
                  className="p-8 text-center text-sm text-muted-foreground border-dashed border-amber-300 bg-amber-50/40"
                >
                  <Sparkles className="size-5 mx-auto mb-2 text-amber-500/70" />
                  <div className="font-medium text-foreground mb-1">Can’t reach the workflow service</div>
                  <div>Your run is safe — this panel will reconnect automatically. Check that Paperclip and the chatbot backend are running.</div>
                </Card>
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
        <div className="px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-12 gap-6">
          <Card
            glass
            elevation={3}
            className="lg:col-span-4 pointer-events-auto rounded-2xl p-3 flex flex-col gap-2 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background transition-shadow"
          >
          {/* Target row */}
          <div className="flex items-center justify-between gap-2 px-1">
            <TargetPicker
              project={targetProject}
              feature={targetFeature}
              refreshKey={featuresRefreshKey}
              onChange={(p, f) => { setTargetProject(p); setTargetFeature(f); }}
              onCreated={(p, f) => {
                setTargetProject(p);
                setTargetFeature(f);
                setFeaturesRefreshKey((k) => k + 1);
              }}
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
      </>
      )}
    </div>
  );
}
