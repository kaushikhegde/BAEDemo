import type { Config } from "../shared/config.js";
import { userError, serviceError, authError } from "../shared/errors.js";

export interface WsCtx { cfg: Config }

/**
 * One call to the Scyne chatbot API.
 *
 * Deliberately near-identical to orchFetch rather than shared with it: they
 * point at different services with different error vocabularies, and the one
 * thing this must do that orchFetch need not is tell a REFUSED CREDENTIAL apart
 * from a service that is simply down — an operator chases those two in
 * different places.
 *
 * Nothing thrown from here names a host, a port, a repository command or an
 * environment variable. See `shared/errors.ts` for why.
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
    // The URL and the connection error are an operator's business. A caller who
    // installed a plugin cannot start a service, and telling them which host
    // refused only discloses where it runs.
    throw serviceError("service_unavailable", e, { context: { service: "chatbot", method, path } });
  }

  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }

  if (res.status === 401) {
    // The credential belongs to the INSTALLATION, not to the person calling —
    // so there is nothing here for them to set, whatever the old message said.
    throw authError(`chatbot refused the credential for ${method} ${path}`, { service: "chatbot", path });
  }
  if (!res.ok) {
    const code = parsed?.error ? String(parsed.error) : `http_${res.status}`;
    // A structured `message` is written for a person and passes through. A raw
    // body does not: it used to be spliced in 300 characters at a time, which
    // is a stack trace or an HTML error page as often as it is a sentence.
    if (parsed?.message) throw userError(code, String(parsed.message));
    throw serviceError(code, text.slice(0, 400), {
      nothingChanged: false, context: { service: "chatbot", method, path, status: res.status },
    });
  }
  return parsed as T;
};
