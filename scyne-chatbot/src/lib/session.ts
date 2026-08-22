// What a fresh sign-in forgets.
//
// Signing in used to inherit whatever the last person left behind: the chat
// transcript, the pinned project, the workflow being watched. Logging OUT
// cleared the chat, and an expiry deliberately did not — an expiry is not a
// sign-out, and losing the conversation would punish someone for it — but
// nothing cleared anything on the way IN. So a session that expired and was
// renewed, or a second person on the same browser, opened onto the previous
// conversation and the previous project's UI tab.
//
// The CLI has always done this: `history = []` on sign-in, commented "a new
// person should not inherit the last one's conversation" (cli/repl.ts).
//
// Only SESSION state is listed. The display preferences below are settings a
// person chose for themselves and are deliberately kept:
//   scyne_view · scyne_activity_view · scyne_show_agent_runs
export const SESSION_KEYS = [
  "scyne_chat_messages",
  "scyne_chat_history",
  "scyne_conversation_id",
  "scyne_parent_issue_id",
  "scyne_target",
  "scyne_ui_issue_id",
] as const;

/** Forget the previous session. Safe in private mode, where writes throw. */
export function clearPersistedSession(): void {
  if (typeof window === "undefined") return;
  for (const key of SESSION_KEYS) {
    try { window.localStorage.removeItem(key); } catch { /* private mode */ }
  }
}
