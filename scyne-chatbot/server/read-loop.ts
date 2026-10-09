/**
 * Let the model read before it answers.
 *
 * Every other chat tool is one-way: the model names a tool, the browser runs it
 * and shows the result, and the result never returns to the model. That is
 * right for "run the data model", and it is why the model could not answer
 * "is there a supplier persona?" — it had no way to look. `read_artefact` is
 * the one tool the SERVER runs, inside the same conversation, so the model
 * sees the file and answers from it.
 */
export const READ_TOOL = "read_artefact";

/** Enough for "compare the personas with the capability map", and a ceiling on a model that keeps asking. */
export const MAX_READ_ROUNDS = 3;

export const ANSWER_NOW =
  "You have read enough. Answer the user now from what you have already read. Do not call read_artefact again.";

/**
 * Calls the browser should still receive, but that must not stop a read.
 *
 * The prompt makes every turn that names a project carry `set_target`, so
 * "what personas does BAE have?" arrives as `set_target` + `read_artefact`.
 * Treated as an action, it ended the loop, the read was dropped, and the user
 * got "Target set to BAE." instead of an answer. It is held instead,
 * acknowledged to the model, and handed back with the final turn.
 */
const PASSIVE = new Set(["set_target"]);

export interface ChatTurns {
  sendMessage(request: string | object[]): Promise<{ response: any }>;
}

type Call = { name: string; args: Record<string, unknown>; part: any };

function callsOf(response: any): Call[] {
  const parts: any[] = response?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p?.functionCall)
    .map((p) => ({ name: String(p.functionCall.name), args: p.functionCall.args ?? {}, part: p }));
}

/**
 * The turn the browser receives: no reads, since it has no handler for one,
 * and any held passive call it does not already carry, placed FIRST — the
 * browser runs only the last call of a turn, so an action must stay last.
 */
function forBrowser(response: any, held: any[]): any {
  const cand = response?.candidates?.[0];
  if (!Array.isArray(cand?.content?.parts)) return response;
  const kept = cand.content.parts.filter((p: any) => p?.functionCall?.name !== READ_TOOL);
  const present = new Set(kept.map((p: any) => p?.functionCall?.name).filter(Boolean));
  const parts = [...held.filter((p) => !present.has(p.functionCall.name)), ...kept];
  return { ...response, candidates: [{ ...cand, content: { ...cand.content, parts } }, ...response.candidates.slice(1)] };
}

export async function answerWithReads(
  turns: ChatTurns,
  first: any,
  read: (args: Record<string, unknown>) => Promise<object>,
  maxRounds = MAX_READ_ROUNDS,
): Promise<any> {
  let response = first;
  const held: any[] = [];
  for (let round = 0; ; round++) {
    const calls = callsOf(response);
    // Anything other than a read (or a passive call) is an ACTION, and actions
    // belong to the browser exactly as before. Any text alongside a read is
    // dropped: it is "let me check", and the answer comes after the read.
    const reads = calls.filter((c) => c.name === READ_TOOL);
    if (reads.length === 0 || calls.some((c) => c.name !== READ_TOOL && !PASSIVE.has(c.name))) {
      return forBrowser(response, held);
    }

    // Gemini rejects a plain-text turn after a function call it has had no
    // response to, so the limit is delivered AS the function response — and
    // every call in the turn, passive ones included, gets one.
    const atLimit = round >= maxRounds;
    const replies = await Promise.all(
      calls.map(async (c) => {
        if (c.name !== READ_TOOL) {
          held.push(c.part);
          return { functionResponse: { name: c.name, response: { state: "ok" } } };
        }
        return {
          functionResponse: {
            name: READ_TOOL,
            response: atLimit
              ? { state: "limit", reason: ANSWER_NOW }
              : await read(c.args).catch((e: any) => ({ state: "invalid", reason: `Could not read it: ${e?.message ?? e}` })),
          },
        };
      }),
    );
    response = (await turns.sendMessage(replies)).response;
    if (atLimit) return forBrowser(response, held);
  }
}
