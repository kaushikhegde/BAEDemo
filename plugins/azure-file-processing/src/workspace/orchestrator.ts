import type { Config } from "../shared/config.js";

export interface OrchCtx { cfg: Config }

/**
 * One call to the Scyne orchestrator.
 *
 * Errors are surfaced VERBATIM rather than reshaped. A 502 from the orchestrator
 * must not become a cheerful empty result — a model that cannot tell "no issues"
 * from "the server is down" will report the wrong thing to a person.
 */
export const orchFetch = async <T>(
  cfg: Config, method: string, path: string, body?: unknown,
): Promise<T> => {
  const url = `${cfg.orchUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (cfg.orchToken) headers.authorization = `Bearer ${cfg.orchToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e: any) {
    throw new Error(
      `cannot reach the orchestrator at ${url}: ${e?.message ?? e}. ` +
      `Is it running? \`npm run dev\` from the repo root starts it on :3100.`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`orchestrator answered ${res.status} for ${method} ${path}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
};
