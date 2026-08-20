// The CLI's HTTP client.
//
// Everything the CLI does goes through the same API the browser uses. That is
// the whole parity argument: a capability the CLI cannot reach is a route that
// does not exist, rather than a feature someone forgot to port. There is no
// direct database access here on purpose — permission checks, pre-flight
// refusals and the audit trail all live behind the API, and a second
// implementation of them would drift within a week.

import { load, type CliConfig } from "./config.ts";

export class ApiError extends Error {
  // Declared and assigned rather than a `constructor(readonly status: …)`
  // parameter property. Node runs this file by ERASING types, and a parameter
  // property is the one TypeScript feature that needs code generated rather
  // than removed — using one costs the CLI its ability to run on plain `node`.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export interface Client {
  config: CliConfig;
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  patch<T = any>(path: string, body?: unknown): Promise<T>;
  put<T = any>(path: string, body?: unknown): Promise<T>;
  del<T = any>(path: string): Promise<T>;
}

export function createClient(overrides: Partial<CliConfig> = {}): Client {
  const config = { ...load(), ...overrides };

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(config.apiUrl + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          ...(config.org ? { "x-scyne-org": config.org } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // A refused connection is by far the most common failure and the least
      // self-explanatory, so it names the address and the likely cause rather
      // than surfacing ECONNREFUSED alone.
      throw new ApiError(0,
        `cannot reach the Scyne server at ${config.apiUrl}.\n` +
        `  Is it running? Start it with \`npm run serve\`, or point elsewhere with\n` +
        `  \`scyne login --api <url>\` or $SCYNE_API_URL.\n\n  (${err instanceof Error ? err.message : String(err)})`);
    }

    const text = await res.text();
    const parsed = text ? safeJson(text) : null;

    if (!res.ok) {
      // `message` first, then `error`. Some routes answer with BOTH: a stable
      // machine-readable code in `error` (`name_taken`) and a sentence in
      // `message`. A person reading a terminal needs the sentence; printing
      // the code alone makes a legible refusal look like a crash.
      const obj = (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : null;
      const detail = obj && typeof obj.message === "string" && obj.message
        ? obj.message
        : obj && "error" in obj
          ? String(obj.error)
          : text.slice(0, 500) || res.statusText;
      if (res.status === 401) {
        throw new ApiError(401, `not authenticated — run \`scyne login\`.\n  (${detail})`);
      }
      // A pinned organisation that this account may not act as is the one 403
      // worth explaining: the command looks unrelated to the pin that caused it.
      if (res.status === 403 && /x-scyne-org|superadmin/i.test(detail)) {
        throw new ApiError(403,
          `you are not a superadmin, so you cannot act as another organisation.\n` +
          `  Clear the pin with \`scyne org use --clear\`.\n\n  (${detail})`);
      }
      if (res.status === 404 && /organisation/i.test(detail)) {
        throw new ApiError(404,
          `${detail}\n  The organisation pinned in ${"~/.scyne/config.json"} no longer resolves.\n` +
          `  Clear it with \`scyne org use --clear\`.`);
      }
      throw new ApiError(res.status, detail);
    }
    return parsed as T;
  }

  return {
    config,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    patch: (p, b) => call("PATCH", p, b ?? {}),
    put: (p, b) => call("PUT", p, b ?? {}),
    del: (p) => call("DELETE", p),
  };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { error: text }; }
}

/**
 * Resolve a project NAME to its id, because every URL takes an id while every
 * human types a name. Reports the names that do exist — a typo is the usual
 * cause and the list is usually short.
 */
export async function resolveProject(client: Client, name: string): Promise<{ id: string; name: string }> {
  const projects = await client.get<{ id: string; name: string }[]>("/projects");
  const hit = projects.find(p => p.name === name)
    ?? projects.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (!hit) {
    throw new ApiError(404,
      `no project named '${name}'.\n` +
      (projects.length
        ? `  You have access to: ${projects.map(p => p.name).join(", ")}`
        : `  You have access to no projects yet — create one with \`scyne project create <name>\`.`));
  }
  return hit;
}

/** The project a command should act on: an explicit flag, else `scyne use`. */
export function targetProject(client: Client, explicit?: string): string {
  const name = explicit ?? client.config.project;
  if (!name) {
    throw new ApiError(400,
      `no project selected.\n` +
      `  Pass --project <name>, or pin one with \`scyne use <name>\`.`);
  }
  return name;
}
