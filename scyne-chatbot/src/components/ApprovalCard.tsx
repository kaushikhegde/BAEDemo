import { useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ApprovalCardData } from "../types";
import { ArtifactsPreview } from "./ArtifactsPreview";

export function ApprovalCard({ approval, onApprove, onReject }: {
  approval: ApprovalCardData;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

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
      <CardContent>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="inline-flex items-center gap-1 text-xs font-medium text-scyne-ink-600 hover:text-scyne-ink-700 transition-colors"
        >
          <ChevronDown
            className={`size-3.5 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Hide what will be pushed" : "Review what will be pushed"}
        </button>
        {expanded && <ArtifactsPreview />}
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
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={async () => { setBusy(true); try { await onReject(approval.id); } finally { setBusy(false); } }}
        >
          <X />
          Reject
        </Button>
      </CardFooter>
    </Card>
  );
}
