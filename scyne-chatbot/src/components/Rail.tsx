import { MessageSquare, ListTodo, Receipt, ScrollText, FolderOpen } from "lucide-react";

/**
 * The left rail — this app's top-level navigation.
 *
 * A rail rather than more tabs on the right pane, because the chatbot is now
 * the client people work in rather than only a way to start a run: surfaces
 * keep arriving, and a rail absorbs a fifth one where a tab strip in a
 * half-width panel does not. Chat is first and opens the two-pane workspace
 * unchanged — the conversation is still what this app is for.
 */

export type View = "workspace" | "documents" | "issues" | "spend" | "actions" | "history";

/** Which views exist, in rail order. `admin` gates the commercially sensitive two. */
const ITEMS: Array<{ view: View; label: string; Icon: typeof MessageSquare; admin?: boolean }> = [
  { view: "workspace", label: "Chat", Icon: MessageSquare },
  // Beside Chat rather than further down: what a project holds is the first
  // thing anyone checks when a stage says it has no documents, and the first
  // thing they need to change when it read the wrong ones.
  { view: "documents", label: "Docs", Icon: FolderOpen },
  { view: "issues", label: "Issues", Icon: ListTodo },
  { view: "spend", label: "Spend", Icon: Receipt, admin: true },
  { view: "actions", label: "Actions", Icon: ScrollText, admin: true },
];

export function Rail({
  view, onChange, isAdmin, needsAttention,
}: {
  view: View;
  onChange: (v: View) => void;
  /**
   * Whether to SHOW the admin items. Hiding is cosmetic — the orchestrator
   * refuses `/spend` and `/actions` for a member whether or not this rail
   * offers them, and that refusal is the actual boundary. Hiding only spares
   * somebody a row that would always answer "you cannot see this".
   */
  isAdmin: boolean;
  /** Issues sitting in_review / blocked / paused. Nothing moves them but a person. */
  needsAttention: number;
}) {
  return (
    <nav
      aria-label="Sections"
      className="shrink-0 w-[74px] border-r border-scyne-line bg-white/60 flex flex-col items-stretch gap-1 py-4 px-2"
    >
      {ITEMS.filter((i) => !i.admin || isAdmin).map(({ view: v, label, Icon }) => {
        const active = view === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            aria-current={active ? "page" : undefined}
            className={[
              "relative rounded-lg py-2.5 flex flex-col items-center gap-1 text-[11px] font-medium transition-colors",
              active
                ? "bg-scyne-ink text-white"
                : "text-scyne-ink/70 hover:bg-scyne-line/60 hover:text-scyne-ink",
            ].join(" ")}
          >
            <Icon className="size-[18px]" aria-hidden />
            {label}
            {v === "issues" && needsAttention > 0 && (
              <span
                // Announced, not merely coloured: "2 issues need you" is the
                // whole reason to glance at this rail, and a bare dot says
                // nothing to a screen reader.
                aria-label={`${needsAttention} ${needsAttention === 1 ? "issue needs" : "issues need"} you`}
                className={[
                  "absolute top-1.5 right-2 min-w-[17px] h-[17px] px-1 rounded-full",
                  "text-[10px] leading-[17px] font-semibold text-center",
                  active ? "bg-white text-scyne-ink" : "bg-scyne-ink text-white",
                ].join(" ")}
              >
                {needsAttention > 9 ? "9+" : needsAttention}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
