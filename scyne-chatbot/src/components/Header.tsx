import type { ReactNode } from "react";

export function Header({ right }: { right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 glass border-b border-white/40 shadow-elev-1">
      <div className="w-full px-6 lg:px-8 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img
            src="/scyne-logo-ink.svg"
            alt="Scyne"
            className="h-6 w-auto select-none"
            draggable={false}
          />
          <span className="hidden sm:inline-block h-4 w-px bg-slate-300/70" aria-hidden />
          <span className="hidden sm:inline text-[13px] text-muted-foreground tracking-wide">
            AI Powered SalesForce Delivery
          </span>
        </div>
        <div className="flex items-center gap-2">{right}</div>
      </div>
      <div className="h-px bg-brand-gradient opacity-60" aria-hidden />
    </header>
  );
}
