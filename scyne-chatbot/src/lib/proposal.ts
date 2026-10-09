import type { RevisionProposal, UIMessage } from "../types";

/** What each artefact is called on the card. Matches the revise_artefact enum. */
export const ARTEFACT_LABELS: Record<string, string> = {
  capabilities: "capability map",
  personas: "personas and journeys",
  requirements: "product summary and stories",
  ui: "UI mockups",
  datamodel: "data model",
  architecture: "solution architecture",
  qa: "test pack",
  design: "solution design",
};

/** The card for a `revise_artefact` call, or what is missing from it. */
export function proposalMessage(
  input: Record<string, unknown>,
  target: { project: string | null; feature: string | null },
): UIMessage | { error: string } {
  const project = String(input.project || target.project || "").trim();
  const feature = String(input.feature || target.feature || "").trim();
  const artefact = String(input.artefact || "").trim();
  const instruction = String(input.instruction || "").trim();
  if (!project) return { error: "Which project is that change for?" };
  if (!artefact || !instruction) return { error: "I didn't catch what to change — say it once more?" };
  const proposal: RevisionProposal = { project, artefact, instruction, state: "pending" };
  if (feature) proposal.feature = feature;
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    kind: "proposal",
    text: `Change the ${ARTEFACT_LABELS[artefact] ?? artefact}: "${instruction}"`,
    proposal,
  };
}

/**
 * Take a pending card for starting. Null when it is not pending, so a second
 * click on Start change — or a click on a card already started before a
 * reload — starts nothing.
 */
export function claimProposal(
  messages: UIMessage[],
  id: string,
): { messages: UIMessage[]; proposal: RevisionProposal } | null {
  const card = messages.find((m) => m.id === id);
  if (!card?.proposal || card.proposal.state !== "pending") return null;
  return { messages: settleProposal(messages, id, { state: "starting" }), proposal: card.proposal };
}

export function settleProposal(messages: UIMessage[], id: string, patch: Partial<RevisionProposal>): UIMessage[] {
  return messages.map((m) => (m.id === id && m.proposal ? { ...m, proposal: { ...m.proposal, ...patch } } : m));
}
