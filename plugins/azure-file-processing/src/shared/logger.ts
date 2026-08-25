export type LogValue = string | number | boolean | null;

const MAX_FIELD_CHARS = 512;

export interface Logger {
  info(event: string, fields?: Record<string, LogValue>): void;
  warn(event: string, fields?: Record<string, LogValue>): void;
  error(event: string, fields?: Record<string, LogValue>): void;
}

/** The logger takes an explicit allowlist of SCALARS. A caller cannot hand it a
 *  buffer, a parsed document or a request body and have it serialised: that is
 *  how file content ends up in a log file, and the acceptance suite greps for
 *  exactly that. Refusing is louder than truncating. */
const emit = (level: string, event: string, fields: Record<string, LogValue>) => {
  for (const [k, v] of Object.entries(fields)) {
    const t = typeof v;
    if (v !== null && t !== "string" && t !== "number" && t !== "boolean") {
      throw new Error(`logger: field "${k}" is non-scalar (${t}); log an id, not a payload`);
    }
    if (typeof v === "string" && v.length > MAX_FIELD_CHARS) {
      throw new Error(`logger: field "${k}" is too long (${v.length} chars, max ${MAX_FIELD_CHARS})`);
    }
  }
  process.stdout.write(JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields }) + "\n");
};

export const makeLogger = (): Logger => ({
  info: (event, fields = {}) => emit("info", event, fields),
  warn: (event, fields = {}) => emit("warn", event, fields),
  error: (event, fields = {}) => emit("error", event, fields),
});

export const log = makeLogger();
