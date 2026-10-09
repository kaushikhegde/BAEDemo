import { describe, it, expect, vi } from "vitest";
import { answerWithReads, READ_TOOL, MAX_READ_ROUNDS } from "./read-loop.js";

/**
 * The chat's tools used to be one-way: the model asked, the browser acted, and
 * nothing came back. Reading an artefact has to come back — the model cannot
 * answer a question about a file it never saw.
 */

const turn = (...parts: object[]) => ({ candidates: [{ content: { role: "model", parts } }] });
const read = (args: object) => ({ functionCall: { name: READ_TOOL, args } });
const text = (t: string) => ({ text: t });
const partsOf = (r: any) => r.candidates[0].content.parts;

function fakeTurns(replies: object[]) {
  const sent: any[] = [];
  return {
    sent,
    sendMessage: async (request: any) => {
      sent.push(request);
      return { response: replies.shift() ?? turn(text("(out of replies)")) };
    },
  };
}

describe("answerWithReads", () => {
  it("returns a turn with no tool calls untouched", async () => {
    const turns = fakeTurns([]);
    const first = turn(text("Hello"));
    expect(await answerWithReads(turns, first, vi.fn())).toEqual(first);
    expect(turns.sent).toHaveLength(0);
  });

  it("reads, sends the result back, and returns the answer", async () => {
    const turns = fakeTurns([turn(text("The closest is Procurement Officer (PO)."))]);
    const reader = vi.fn(async () => ({ state: "ok", content: "# Personas\nProcurement Officer (PO)" }));
    const out = await answerWithReads(turns, turn(read({ project: "BAE", artefact: "personas" })), reader);
    expect(reader).toHaveBeenCalledWith({ project: "BAE", artefact: "personas" });
    expect(turns.sent[0][0].functionResponse).toEqual({
      name: READ_TOOL,
      response: { state: "ok", content: "# Personas\nProcurement Officer (PO)" },
    });
    expect(partsOf(out)).toEqual([text("The closest is Procurement Officer (PO).")]);
  });

  it("answers two reads from one turn in one message", async () => {
    const turns = fakeTurns([turn(text("done"))]);
    const reader = vi.fn(async (a: any) => ({ state: "ok", content: a.artefact }));
    await answerWithReads(turns, turn(read({ artefact: "capabilities" }), read({ artefact: "personas" })), reader);
    expect(turns.sent).toHaveLength(1);
    expect(turns.sent[0].map((p: any) => p.functionResponse.response.content)).toEqual(["capabilities", "personas"]);
  });

  it("drops text that came with a read", async () => {
    const turns = fakeTurns([turn(text("answer"))]);
    const out = await answerWithReads(turns, turn(text("Let me check…"), read({ artefact: "qa" })), async () => ({ state: "ok" }));
    expect(partsOf(out)).toEqual([text("answer")]);
  });

  it("hands any other tool to the browser and removes the reads", async () => {
    const turns = fakeTurns([]);
    const revise = { functionCall: { name: "revise_artefact", args: { artefact: "personas" } } };
    const out = await answerWithReads(turns, turn(read({ artefact: "personas" }), revise), vi.fn());
    expect(turns.sent).toHaveLength(0);
    expect(partsOf(out)).toEqual([revise]);
  });

  it("stops after three rounds with a function response, never bare text", async () => {
    // Gemini rejects a plain-text turn after a function call it has not had a
    // response to, so the limit itself has to arrive as a function response.
    const always = () => turn(read({ artefact: "capabilities" }));
    const turns = fakeTurns([always(), always(), always(), turn(text("best I can say"))]);
    const reader = vi.fn(async () => ({ state: "ok" }));
    const out = await answerWithReads(turns, always(), reader);
    expect(reader).toHaveBeenCalledTimes(MAX_READ_ROUNDS);
    expect(turns.sent).toHaveLength(MAX_READ_ROUNDS + 1);
    const last = turns.sent.at(-1);
    expect(Array.isArray(last)).toBe(true);
    expect(last[0].functionResponse.response.state).toBe("limit");
    expect(partsOf(out)).toEqual([text("best I can say")]);
  });

  it("removes a read the model still asks for after the limit", async () => {
    const always = () => turn(read({ artefact: "capabilities" }));
    const turns = fakeTurns([always(), always(), always(), always()]);
    const out = await answerWithReads(turns, always(), async () => ({ state: "ok" }));
    expect(partsOf(out)).toEqual([]);
  });

  it("tells the model when a read throws, and carries on", async () => {
    const turns = fakeTurns([turn(text("could not read it"))]);
    await answerWithReads(turns, turn(read({ artefact: "qa" })), async () => { throw new Error("EACCES"); });
    expect(turns.sent[0][0].functionResponse.response).toEqual({ state: "invalid", reason: "Could not read it: EACCES" });
  });

  it("reads alongside set_target, then hands set_target back with the answer", async () => {
    // The prompt makes every turn that names a project carry set_target, so
    // "what personas does BAE have?" arrives as set_target + read_artefact.
    // Treating set_target as an action dropped the read and the user got
    // "Target set to BAE." instead of an answer.
    const target = { functionCall: { name: "set_target", args: { project: "BAE" } } };
    const turns = fakeTurns([turn(text("Alex, Jordan, Sam, Morgan and Chris."))]);
    const reader = vi.fn(async () => ({ state: "ok", content: "personas" }));
    const out = await answerWithReads(turns, turn(target, read({ project: "BAE", artefact: "personas" })), reader);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(turns.sent[0].map((p: any) => p.functionResponse.name)).toEqual(["set_target", READ_TOOL]);
    expect(turns.sent[0][0].functionResponse.response).toEqual({ state: "ok" });
    expect(partsOf(out)).toEqual([target, text("Alex, Jordan, Sam, Morgan and Chris.")]);
  });

  it("does not hand set_target back twice when the answer carries its own", async () => {
    const target = { functionCall: { name: "set_target", args: { project: "BAE" } } };
    const turns = fakeTurns([turn(target, text("done"))]);
    const out = await answerWithReads(turns, turn(target, read({ artefact: "personas" })), async () => ({ state: "ok" }));
    expect(partsOf(out)).toEqual([target, text("done")]);
  });

  it("puts a held set_target before an action, so the action is the call the browser runs", async () => {
    const target = { functionCall: { name: "set_target", args: { project: "BAE" } } };
    const revise = { functionCall: { name: "revise_artefact", args: { artefact: "personas" } } };
    const turns = fakeTurns([turn(revise)]);
    const out = await answerWithReads(turns, turn(target, read({ artefact: "personas" })), async () => ({ state: "ok" }));
    expect(partsOf(out)).toEqual([target, revise]);
  });
});

