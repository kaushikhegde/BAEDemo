import type { Config } from "../shared/config.js";

export interface WsCtx { cfg: Config }

/**
 * One call to the Scyne chatbot API.
 *
 * Deliberately near-identical to orchFetch rather than shared with it: they
 * point at different services with different error vocabularies, and the one
 * thing this must do that orchFetch need not is turn a 401 into a message about
 * a TOKEN rather than about the operation.
 */
export const chatFetch = async <T>(
  cfg: Config, method: string, path: string, body?: unknown,
): Promise<T> => {
  const url = `${cfg.chatbotUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (cfg.orchToken) headers.authorization = `Bearer ${cfg.orchToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e: any) {
    throw new Error(
      `cannot reach the Scyne chatbot at ${url}: ${e?.message ?? e}. ` +
      `\`npm run dev\` from the repo root starts it.`);
  }

  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }

  if (res.status === 401) {
    throw new Error(
      `not_authenticated: the chatbot refused the credential for ${method} ${path}. ` +
      `Set SCYNE_ORCH_TOKEN to a Scyne API token — the chatbot accepts the same ` +
      `Bearer token the orchestrator does.`);
  }
  if (!res.ok) {
    const code = parsed?.error ? String(parsed.error) : `http_${res.status}`;
    const msg = parsed?.message ? ` — ${parsed.message}` : ` — ${text.slice(0, 300)}`;
    throw new Error(`${code}${msg}`);
  }
  return parsed as T;
};
