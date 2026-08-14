import { Check, PencilLine } from "lucide-react";
import { MiniMarkdown } from "./MiniMarkdown";
import { LinksPanel } from "./LinksPanel";
import type { UIMessage } from "../types";

function DecisionRecord({ m }: { m: UIMessage }) {
  const d = m.decision!;
  const approved = d.outcome === "approved";
  const when = (() => {
    try {
      return new Date(d.at).toLocaleString(undefined, {
        day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
      });
    } catch { return ""; }
  })();

  return (
    <div className="flex justify-start gap-3 animate-slide-up">
      <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-transparent" />
      <div
        className={`max-w-[88%] w-full min-w-0 rounded-lg border px-3 py-2.5 ${
          approved
            ? "border-emerald-200 bg-emerald-50/70"
            : "border-amber-200 bg-amber-50/70"
        }`}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 text-[12px] font-semibold ${
              approved ? "text-emerald-800" : "text-amber-800"
            }`}
          >
            {approved ? <Check className="size-3.5" /> : <PencilLine className="size-3.5" />}
            {approved ? "You approved" : "You requested changes"}
          </span>
          {d.issue && (
            <span className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600">
              {d.issue}
            </span>
          )}
          {when && <span className="text-[11px] text-slate-500">{when}</span>}
        </div>
        {d.title && (
          <div className="mt-1 text-[13.5px] font-medium text-slate-800">{d.title}</div>
        )}
        {d.note && (
          <div className="mt-1.5 border-l-2 border-amber-300 pl-2 text-[13px] italic text-slate-700 whitespace-pre-wrap">
            {d.note}
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageBubble({ m }: { m: UIMessage }) {
  if (m.kind === "decision" && m.decision) return <DecisionRecord m={m} />;
  if (m.kind === "links" && m.links) {
    return (
      <div className="flex justify-start gap-3 animate-slide-up">
        <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-transparent" />
        <div className="max-w-[88%] w-full min-w-0">
          <LinksPanel links={m.links} />
        </div>
      </div>
    );
  }

  const mine = m.role === "user";
  if (mine) {
    return (
      <div className="flex justify-end animate-slide-up">
        <div className="max-w-[72%] rounded-2xl rounded-br-md px-4 py-2.5 leading-relaxed whitespace-pre-wrap text-[15px] bg-brand-gradient text-white shadow-glow">
          {m.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start gap-3 animate-slide-up">
      <span
        aria-hidden
        className="mt-2 size-2 shrink-0 rounded-full bg-brand-gradient shadow-glow"
      />
      <div className="max-w-[88%] min-w-0 break-words text-[15px] leading-7 text-slate-800">
        <MiniMarkdown source={m.text} />
      </div>
    </div>
  );
}
