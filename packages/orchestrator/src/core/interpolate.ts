// Substitutes `{name}` placeholders in a template string with values from
// `vars`. Throwing on an unknown placeholder is deliberate, not defensive: a
// silently un-substituted `{feature}` becomes a shell command running
// against a directory literally named `{feature}` — a failure that surfaces
// far from its cause.
export function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (!(name in vars)) {
      throw new Error(
        `unknown placeholder {${name}} — available: ${Object.keys(vars).join(", ") || "(none)"}`
      );
    }
    return vars[name];
  });
}
