import { MiniMarkdown } from "./MiniMarkdown";
import type { UIMessage } from "../types";

export function MessageBubble({ m }: { m: UIMessage }) {
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
      <div className="max-w-[88%] text-[15px] leading-7 text-slate-800">
        <MiniMarkdown source={m.text} />
      </div>
    </div>
  );
}
