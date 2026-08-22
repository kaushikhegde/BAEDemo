// What a sign-in forgets, and what it must not.
//
// The rule this pins: session state goes, display preferences stay. Getting it
// backwards is invisible — nobody notices their sidebar preference resetting,
// and nobody notices the previous person's conversation still being there
// until it is on a client's screen.

import { describe, expect, it, beforeEach } from "vitest";
import { SESSION_KEYS, clearPersistedSession } from "./session";

const PREFERENCES = ["scyne_view", "scyne_activity_view", "scyne_show_agent_runs"];

// A map-backed localStorage. There is no jsdom in this project — only vitest —
// and adding a DOM just to read and delete string keys would be a dependency
// for no gain. This is the whole of the API the module touches.
const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  },
};

beforeEach(() => {
  store.clear();
  for (const k of [...SESSION_KEYS, ...PREFERENCES]) window.localStorage.setItem(k, "x");
});

describe("clearPersistedSession", () => {
  it("forgets every piece of the previous session", () => {
    clearPersistedSession();
    expect(SESSION_KEYS.filter(k => window.localStorage.getItem(k) !== null)).toEqual([]);
  });

  it("keeps the display preferences, which are the person's own settings", () => {
    clearPersistedSession();
    expect(PREFERENCES.filter(k => window.localStorage.getItem(k) === null)).toEqual([]);
  });

  it("covers the transcript, the pinned target and the conversation", () => {
    for (const k of ["scyne_chat_messages", "scyne_chat_history", "scyne_target", "scyne_conversation_id"]) {
      expect([k, SESSION_KEYS.includes(k as never)]).toEqual([k, true]);
    }
  });
});
