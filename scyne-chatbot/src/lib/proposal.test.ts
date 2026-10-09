import { describe, it, expect } from "vitest";
import { proposalMessage, claimProposal, settleProposal } from "./proposal";
import type { UIMessage } from "../types";

describe("proposalMessage", () => {
  const target = { project: "BAE", feature: null };

  it("builds a pending card from the tool call", () => {
    const m = proposalMessage({ artefact: "personas", instruction: "add a supplier persona" }, target);
    expect("error" in m).toBe(false);
    if ("error" in m) return;
    expect(m.kind).toBe("proposal");
    expect(m.proposal).toEqual({ project: "BAE", artefact: "personas", instruction: "add a supplier persona", state: "pending" });
  });

  it("keeps the feature for a feature-level artefact", () => {
    const m = proposalMessage({ project: "BAE", feature: "intake", artefact: "qa", instruction: "x" }, target);
    expect(!("error" in m) && m.proposal?.feature).toBe("intake");
  });

  it("refuses a call with no instruction", () => {
    expect(proposalMessage({ artefact: "personas" }, target)).toHaveProperty("error");
  });

  it("refuses a call with no project and no target", () => {
    expect(proposalMessage({ artefact: "personas", instruction: "x" }, { project: null, feature: null })).toHaveProperty("error");
  });
});

describe("claimProposal", () => {
  const card = (state: any): UIMessage => ({
    id: "p1", role: "assistant", kind: "proposal", text: "",
    proposal: { project: "BAE", artefact: "personas", instruction: "x", state },
  });

  it("claims a pending card and marks it starting", () => {
    const r = claimProposal([card("pending")], "p1");
    expect(r?.proposal.state).toBe("pending");
    expect(r?.messages[0].proposal?.state).toBe("starting");
  });

  it("refuses a card that is not pending — a second click starts nothing", () => {
    for (const s of ["starting", "started", "cancelled"]) expect(claimProposal([card(s)], "p1")).toBeNull();
  });

  it("refuses an unknown id", () => {
    expect(claimProposal([card("pending")], "nope")).toBeNull();
  });
});

describe("settleProposal", () => {
  it("patches only the named card", () => {
    const other: UIMessage = { id: "t", role: "assistant", text: "hi" };
    const card: UIMessage = { id: "p1", role: "assistant", kind: "proposal", text: "", proposal: { project: "BAE", artefact: "personas", instruction: "x", state: "starting" } };
    const out = settleProposal([other, card], "p1", { state: "started", issue: "SCY-12" });
    expect(out[0]).toBe(other);
    expect(out[1].proposal).toMatchObject({ state: "started", issue: "SCY-12" });
  });
});
