import { useState } from "react";
import { Check, ChevronDown, X, PencilLine, Loader2 } from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import type { ApprovalCardData } from "../types";
import { ArtifactsPreview } from "./ArtifactsPreview";

export function ApprovalCard({ approval, project, feature, onApprove, onRequestChanges }: {
  approval: ApprovalCardData;
  project: string | null;
  feature: string | null;
  onApprove: (id: string) => Promise<void>;
  onRequestChanges: (id: string, issueId: string, feedback: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  if (approval.status === "approved") {
    return (
      <div>
        <Badge tone="success" size="md" icon={<Check />}>
          Approved · {approval.issueIdentifier}
        </Badge>
      </div>
    );
  }
  if (approval.status === "rejected") {
    return (
      <div>
        <Badge tone="danger" size="md" icon={<X />}>
          Rejected · {approval.issueIdentifier}
        </Badge>
      </div>
    );
  }
  // The gate was sent back with feedback; the BA is regenerating. Show it as in-progress.
  if (approval.status === "revision_requested") {
    return (
      <Card glass elevation={1} className="ring-1 ring-scyne-iris/30 animate-slide-up">
        <CardHeader>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="neutral" size="sm" icon={<Loader2 className="animate-spin" />}>Regenerating…</Badge>
            <Badge tone="mono" size="sm">{approval.issueIdentifier}</Badge>
          </div>
          <div className="text-sm text-muted-foreground mt-1">
            Your changes were sent to the analyst. A fresh approval will appear here once it’s regenerated.
          </div>
          {approval.decisionNote && (
            <div className="mt-2 rounded-md bg-scyne-ink-50 px-3 py-2 text-xs text-scyne-ink-700 whitespace-pre-wrap">
              <span className="font-semibold">Your notes:</span> {approval.decisionNote}
            </div>
          )}
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card glass elevation={2} className="ring-1 ring-warning-500/30 animate-slide-up">
      <CardHeader>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone="warning" size="sm" pulse>Approval requested</Badge>
          <Badge tone="mono" size="sm">{approval.issueIdentifier}</Badge>
        </div>
        <div className="text-[15px] font-semibold text-foreground mt-1">{approval.title}</div>
        {approval.description && (
          <div className="text-sm text-muted-foreground whitespace-pre-wrap">{approval.description}</div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="inline-flex items-center gap-1 text-xs font-medium text-scyne-ink-600 hover:text-scyne-ink-700 transition-colors"
        >
          <ChevronDown
            className={`size-3.5 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Hide what will be pushed" : "Review what will be pushed"}
        </button>
        {expanded && <ArtifactsPreview project={project} feature={feature} />}

        {showFeedback && (
          <div className="space-y-2 rounded-lg border border-scyne-line bg-white/60 p-3 animate-slide-up">
            <label className="text-xs font-semibold text-scyne-ink-700">
              What should the analyst change?
            </label>
            <Textarea
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="e.g. Split story 3 into two; the personas should use full names; add an acceptance criterion for audit logging…"
              rows={3}
              disabled={busy}
            />
          </div>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={async () => { setBusy(true); try { await onApprove(approval.id); } finally { setBusy(false); } }}
        >
          <Check />
          Approve & push
        </Button>
        {showFeedback ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !feedback.trim()}
              onClick={async () => {
                setBusy(true);
                try { await onRequestChanges(approval.id, approval.issueId, feedback.trim()); }
                finally { setBusy(false); }
              }}
            >
              <PencilLine />
              Send to analyst
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setShowFeedback(false); setFeedback(""); }}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setShowFeedback(true)}>
            <PencilLine />
            Request changes
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
