// Gemini and Azure AI Foundry, as ChatProviders.
//
// Each is a request/response mapping and nothing else: the loop, the tools,
// the transcript and the accounting are shared (see core/agent-loop.ts), so a
// provider's whole job is "given this conversation and these tools, what is
// the next turn".
//
// AZURE: this uses the Responses endpoint, NOT the hosted Agent Service.
// That is deliberate and it is not a preference. Microsoft's documentation is
// explicit that "Runs expire 10 minutes after creation" and that "the
// 10-minute run expiration applies to total elapsed time, not individual
// function execution". A Scyne stage takes twenty-five minutes measured, and
// is budgeted to forty-five. The hosted agent runtime therefore cannot host
// one at all — a capability map would expire mid-run, every time.
//
// The Responses endpoint has no such ceiling because it is stateless per call:
// each request is seconds long, and the twenty-five-minute lifecycle belongs
// to our loop, which no clock in Azure is watching. This also makes Azure
// structurally identical to Gemini here, which is why both fit in one file.
//
// No SDK for either. Both are one HTTPS POST with a JSON body, and adding two
// vendor SDKs — with their own transitive trees, release cadence and breaking
// changes — to a package that currently has three runtime dependencies would
// cost far more than the fetch call it saves.

import type { ChatProvider, CompleteRequest, LoopMessage, ProviderTurn, ProviderToolCall } from "./agent-loop.js";
import type { TOOL_SCHEMAS } from "./tools.js";

type ToolSchemas = typeof TOOL_SCHEMAS;

let callSeq = 0;
/** Gemini does not return an id per function call; the loop needs one to pair results. */
const nextCallId = (): string => `call_${++callSeq}`;

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal):
  Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // The status AND the body: a 400 from either vendor carries the actual
    // reason (bad deployment name, unsupported tool schema) and losing it
    // turns a five-minute fix into an afternoon.
    throw new Error(`${new URL(url).host} → ${res.status} ${res.statusText}: ${text.slice(0, 2000)}`);
  }
  return res.json();
}

// ------------------------------------------------------------------ Gemini

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/**
 * Gemini's `contents` are a flat alternation of `user` and `model` turns, with
 * tool calls as `functionCall` parts and results as `functionResponse` parts
 * carried on a `user` turn. Our LoopMessage shape maps onto that directly.
 */
function toGeminiContents(messages: LoopMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.text }] });
    } else if (m.role === "assistant") {
      const parts: unknown[] = [];
      if (m.text.trim()) parts.push({ text: m.text });
      for (const c of m.toolCalls) parts.push({ functionCall: { name: c.name, args: c.input } });
      // A model turn with no parts at all is rejected; keep it well-formed.
      out.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
    } else {
      out.push({
        role: "user",
        parts: m.results.map(r => ({
          functionResponse: { name: r.name, response: { ok: r.ok, output: r.content } },
        })),
      });
    }
  }
  return out;
}

const toGeminiTools = (tools: ToolSchemas): unknown => ([{
  functionDeclarations: tools.map(t => ({
    name: t.name, description: t.description, parameters: t.parameters,
  })),
}]);

export function createGeminiProvider(opts: GeminiOptions): ChatProvider {
  const model = opts.model ?? "gemini-2.5-pro";
  const baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  if (!opts.apiKey) throw new Error("createGeminiProvider requires an apiKey (GEMINI_API_KEY)");

  return {
    name: "gemini",
    model,
    async complete(req: CompleteRequest): Promise<ProviderTurn> {
      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: toGeminiContents(req.messages),
        tools: toGeminiTools(req.tools),
        // AUTO rather than ANY: the model must be able to stop calling tools
        // and answer, which is how the loop learns the stage is finished.
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      };

      const json = await postJson(
        `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": opts.apiKey }, body, req.signal) as {
          candidates?: { content?: { parts?: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[] } }[];
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };

      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const toolCalls: ProviderToolCall[] = [];
      let text = "";
      for (const p of parts) {
        if (typeof p.text === "string") text += p.text;
        if (p.functionCall) {
          toolCalls.push({ id: nextCallId(), name: p.functionCall.name, input: p.functionCall.args ?? {} });
        }
      }

      return {
        text,
        toolCalls,
        usage: {
          inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
          // Google's API returns no price. Reporting null rather than guessing
          // matches core/usage.ts, which records what the provider states and
          // shows an unpriced model as "—" rather than as a fabricated figure.
          costUsd: null,
        },
      };
    },
  };
}

// ---------------------------------------------------- Azure AI Foundry

export interface AzureOptions {
  /** https://<resource>.services.ai.azure.com/api/projects/<project> or an OpenAI endpoint. */
  endpoint: string;
  /** A bearer token — from `az account get-access-token` or a service principal. */
  token?: string;
  /** An API key, when the resource is configured for key auth instead. */
  apiKey?: string;
  /** The model deployment name. */
  model?: string;
  apiVersion?: string;
}

/**
 * The Responses API takes a flat `input` list of typed items: messages,
 * `function_call`s the model made, and `function_call_output`s we return,
 * paired by `call_id`.
 */
function toAzureInput(messages: LoopMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.text }] });
    } else if (m.role === "assistant") {
      if (m.text.trim()) {
        out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.text }] });
      }
      for (const c of m.toolCalls) {
        out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.input) });
      }
    } else {
      for (const r of m.results) {
        out.push({
          type: "function_call_output",
          call_id: r.id,
          output: JSON.stringify({ ok: r.ok, output: r.content }),
        });
      }
    }
  }
  return out;
}

const toAzureTools = (tools: ToolSchemas): unknown[] =>
  tools.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));

export function createAzureProvider(opts: AzureOptions): ChatProvider {
  const model = opts.model ?? "gpt-4.1";
  const apiVersion = opts.apiVersion ?? "v1";
  if (!opts.endpoint) throw new Error("createAzureProvider requires an endpoint (AZURE_AI_PROJECT_ENDPOINT)");
  if (!opts.token && !opts.apiKey) {
    throw new Error(
      "createAzureProvider requires either a token (az account get-access-token " +
      "--scope https://ai.azure.com/.default) or an apiKey");
  }

  const base = opts.endpoint.replace(/\/+$/, "");
  const headers: Record<string, string> = opts.token
    ? { authorization: `Bearer ${opts.token}` }
    : { "api-key": opts.apiKey as string };

  return {
    name: "azure_foundry",
    model,
    async complete(req: CompleteRequest): Promise<ProviderTurn> {
      const body = {
        model,
        instructions: req.system,
        input: toAzureInput(req.messages),
        tools: toAzureTools(req.tools),
        // Stateless: the whole conversation is resent each turn rather than
        // held server-side in a thread. That is exactly what sidesteps the
        // 10-minute run expiry documented for the hosted Agent Service.
        store: false,
      };

      const json = await postJson(
        `${base}/openai/${apiVersion}/responses`, headers, body, req.signal) as {
          output?: { type?: string; call_id?: string; name?: string; arguments?: string;
                     content?: { type?: string; text?: string }[] }[];
          usage?: { input_tokens?: number; output_tokens?: number };
        };

      const toolCalls: ProviderToolCall[] = [];
      let text = "";
      for (const item of json.output ?? []) {
        if (item.type === "function_call" && item.name) {
          let input: Record<string, unknown> = {};
          // Arguments arrive as a JSON string. A model occasionally emits one
          // that does not parse; an empty object plus the tool's own "missing
          // argument" answer lets it correct itself, where throwing would end
          // a twenty-five-minute run over one malformed turn.
          try { input = item.arguments ? JSON.parse(item.arguments) : {}; } catch { input = {}; }
          toolCalls.push({ id: item.call_id ?? nextCallId(), name: item.name, input });
        } else if (item.type === "message") {
          for (const c of item.content ?? []) if (typeof c.text === "string") text += c.text;
        }
      }

      return {
        text,
        toolCalls,
        usage: {
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
          costUsd: null,   // priced by the Azure subscription, not reported here
        },
      };
    },
  };
}
