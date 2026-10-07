// The one way the companion app writes markup.
//
// html`<p>${text}</p>` escapes every interpolated value unless it is already
// markup (the result of another html`` call, or raw()). Arrays are joined, and
// null / undefined / false render as nothing — so a view can write
// `${cond && html`…`}` without a ternary. The page is built by string
// concatenation in node, and one forgotten esc() is how client text becomes
// markup; making escaping the default removes that whole class of bug.

export const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export class Markup {
  constructor(s) { this.s = String(s); }
  toString() { return this.s; }
}

/** Trusted markup: already-rendered HTML, an SVG we generated, a data URI. */
export const raw = (s) => new Markup(s ?? "");

const value = (v) => {
  if (v == null || v === false) return "";
  if (v instanceof Markup) return v.s;
  if (Array.isArray(v)) return v.map(value).join("");
  return esc(v);
};

export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += value(vals[i]) + strings[i + 1];
  return new Markup(out);
}

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// JSON embedded in a <script> must not be able to close the tag early.
export const jsonIsland = (data) => JSON.stringify(data).replace(/</g, "\\u003c");

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Two-letter initials for an avatar: first and last word. */
export function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
