import type { Config } from "../shared/config.js";
import { userError, serviceError, authError } from "../shared/errors.js";

export interface OrchCtx { cfg: Config }

/**
 * One call to the Scyne orchestrator.
 *
 * A failure is never swallowed. A 502 from the orchestrator must not become a
 * cheerful empty result — a model that cannot tell "no issues" from "the server
 * is down" will report the wrong thing to a person.
 *
 * What it no longer does is surface the response VERBATIM. `text.slice(0, 400)`
 * put whatever the server said on an end user's screen: a stack trace, an HTML
 * error page, a path on the host. The distinction that matters is whether the
 * CALLER can act — a refused argument comes back as it was written, everything
 * else becomes a reference and a log line. See `shared/errors.ts`.
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
    throw serviceError("service_unavailable", e, { context: { service: "orchestrator", method, path } });
  }

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`orchestrator answered ${res.status} for ${method} ${path}`,
        { service: "orchestrator", path, status: res.status });
    }
    // The orchestrator answers a refused REQUEST as JSON carrying `message` —
    // "a viewer cannot create projects", "name is required". Those are the
    // caller's to fix and read as written. Anything else is ours.
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    if (res.status < 500 && parsed?.message) {
      throw userError(parsed.error ? String(parsed.error) : `http_${res.status}`, String(parsed.message));
    }
    throw serviceError(`http_${res.status}`, text.slice(0, 400), {
      nothingChanged: false, context: { service: "orchestrator", method, path, status: res.status },
    });
  }
  return (text ? JSON.parse(text) : undefined) as T;
};
