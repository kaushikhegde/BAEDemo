/**
 * Let the model read before it answers.
 *
 * Every other chat tool is one-way: the model names a tool, the browser runs it
 * and shows the result, and the result never returns to the model. That is
 * right for "run the data model", and it is why the model could not answer
 * "is there a supplier persona?" — it had no way to look. `read_artefact` is
 * the one tool the SERVER runs, on the same chat session, so the model sees
 * the file and answers from it.
 */
export const READ_TOOL = "read_artefact";

/** Enough for "compare the personas with the capability map", and a ceiling on a model that keeps asking. */
export const MAX_READ_ROUNDS = 3;

export const ANSWER_NOW =
  "You have read enough. Answer the user now from what you have already read. Do not call read_artefact again.";

export interface ChatTurns {
  sendMessage(request: string | object[]): Promise<{ response: any }>;
}

type Call = { name: string; args: Record<string, unknown> };

function callsOf(response: any): Call[] {
  const parts: any[] = response?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p?.functionCall)
    .map((p) => ({ name: String(p.functionCall.name), args: p.functionCall.args ?? {} }));
}

/** The browser has no handler for a read, so it never receives one. */
function withoutReads(response: any): any {
  const cand = response?.candidates?.[0];
  if (!Array.isArray(cand?.content?.parts)) return response;
  const parts = cand.content.parts.filter((p: any) => p?.functionCall?.name !== READ_TOOL);
  return { ...response, candidates: [{ ...cand, content: { ...cand.content, parts } }, ...response.candidates.slice(1)] };
}

export async function answerWithReads(
  turns: ChatTurns,
  first: any,
  read: (args: Record<string, unknown>) => Promise<object>,
  maxRounds = MAX_READ_ROUNDS,
): Promise<any> {
  let response = first;
  for (let round = 0; ; round++) {
    const calls = callsOf(response);
    // Anything other than a read is an ACTION, and actions belong to the
    // browser exactly as before. Any text alongside a read is dropped: it is
    // "let me check", and the answer comes after the read.
    if (calls.length === 0 || calls.some((c) => c.name !== READ_TOOL)) return withoutReads(response);

    // Gemini rejects a plain-text turn after a function call it has had no
    // response to, so the limit is delivered AS the function response.
    const atLimit = round >= maxRounds;
    const replies = await Promise.all(
      calls.map(async (c) => ({
        functionResponse: {
          name: READ_TOOL,
          response: atLimit
            ? { state: "limit", reason: ANSWER_NOW }
            : await read(c.args).catch((e: any) => ({ state: "invalid", reason: `Could not read it: ${e?.message ?? e}` })),
        },
      })),
    );
    response = (await turns.sendMessage(replies)).response;
    if (atLimit) return withoutReads(response);
  }
}
