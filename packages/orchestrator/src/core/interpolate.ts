// Substitutes `{name}` placeholders in a template string with values from
// `vars`. Throwing on an unknown placeholder is deliberate, not defensive: a
// silently un-substituted `{feature}` becomes a shell command running
// against a directory literally named `{feature}` — a failure that surfaces
// far from its cause.
//
// A DOUBLED brace — `{{name}}` — is a literal, emitted verbatim and never
// looked up. Prompts routinely need to name a token the agent will find in a
// file it is about to edit ("replace `{{PRODUCT_SUMMARY_URL}}` in each story
// description"), and without an escape the inner `{name}` matched, missed,
// and threw: the requirements workflow's publish step blocked every run with
// `unknown placeholder {PRODUCT_SUMMARY_URL}` immediately after a human had
// approved its gate. Doubling is the escape rather than a backslash because
// the token being quoted is itself usually already written `{{…}}` by
// whatever consumes it, so the template says exactly what the agent will see.
const PLACEHOLDER = /\{\{(\w+)\}\}|\{(\w+)\}/g;

export function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(PLACEHOLDER, (match, literal: string | undefined, name: string | undefined) => {
    if (literal !== undefined) return match;   // {{X}} — a literal, left alone
    const key = name as string;
    if (!(key in vars)) {
      throw new Error(
        `unknown placeholder {${key}} — available: ${Object.keys(vars).join(", ") || "(none)"}`
      );
    }
    return vars[key];
  });
}

/**
 * The placeholder names `interpolate` would substitute in `tpl`, in
 * first-appearance order. Doubled braces are excluded, exactly as they are
 * excluded from substitution — the two must agree, or a form built from this
 * asks for a variable the engine will never read.
 */
export function placeholdersIn(tpl: string): string[] {
  const out: string[] = [];
  for (const m of tpl.matchAll(PLACEHOLDER)) {
    if (m[2] !== undefined && !out.includes(m[2])) out.push(m[2]);
  }
  return out;
}
