// What a project or feature may be called, and what a typed name becomes.
//
// One module because this rule had three copies that disagreed. The wizard
// validated with the READ rule (spaces allowed), the create route refused with
// the WRITE rule (spaces forbidden), and cli/dual.ts carried a third — so the
// Next button lit up on a name the server was about to reject, and the
// hyphenated suggestion the server sent back was thrown away by the caller.
//
// The rule itself is unchanged and still worth having: a project name is also
// the Azure DevOps project name, the wiki path segment, the folder every agent
// resolves paths against, and the `--project` argument on every CLI verb. What
// changed is who obeys it. A person types "SA Power Networks"; the slug is
// applied for them, shown to them before they commit, and the result is ONE
// name — there is no display-name-to-slug mapping to keep in step, because
// there is no second name.
//
// Feature names still take spaces — "Interim Benefit", "Appeals & Reviews" —
// and always will. Every generated command quotes them.

/**
 * The name a typed project name is created under.
 *
 * Idempotent: slugging a slug is the identity, which is what lets a caller
 * apply it defensively without renaming projects that were already fine.
 */
export function slugProjectName(name: string): string {
  return String(name ?? "")
    .trim()
    // A hyphen a person typed and a space they typed mean the same thing here,
    // so "SA - Power" and "SA Power" must not become different projects.
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Whether a slugged name may be created.
 *
 * Deliberately CREATION-only. Reads still admit spaces everywhere, because
 * projects with spaces already exist on disk — `SA Demo` among them — and
 * refusing to open one would be a far worse bug than the one this prevents.
 */
export function isNewProjectName(name: string): boolean {
  if (!name) return false;
  if (!/^[A-Za-z0-9._&-]+$/.test(name)) return false;
  // `.` and `..` satisfy the character class and are not names. A leading dot
  // is either a path climb or a hidden directory; a trailing dot or space is
  // silently stripped by some filesystems, so two names would share one folder.
  if (name.startsWith(".") || /[. ]$/.test(name)) return false;
  return true;
}

/**
 * What `POST /api/projects` should do about a name it has been handed.
 *
 * Extracted because this decision was inlined in a 150-line route and could
 * only be exercised by booting the server — and it is the part that was wrong.
 * It used to be made by calling `fs.access` on a folder and then reading
 * `.published.json` out of it, so a fresh database with the old folders still
 * on disk refused to create projects it had never heard of, naming an Azure
 * DevOps target it could not see.
 *
 * The input is now the project ROW (or its absence), which is the record.
 *
 *   create          — nothing holds this name; make it
 *   exists          — a fully set-up project holds it; refuse
 *   slug_collision  — an INCOMPLETE project holds the slug, but the caller
 *                     typed something else that slugged onto it; refuse
 *   complete        — an INCOMPLETE project holds it and the caller typed it
 *                     exactly; finish setting it up
 *
 * The `slug_collision` case is the subtle one and is deliberately a refusal.
 * Completing a project rewrites its Azure DevOps target and its branding, so
 * it has to be the project the caller actually meant — and `SA Demo` and
 * `SA-Demo` are two different projects that exist side by side in this
 * install. Adopting one because a typed name happened to slug onto it would
 * hand one client's tree another client's target, in a route that reports
 * success.
 */
export type CreateDecision = "create" | "exists" | "slug_collision" | "complete";

export function decideCreate(input: {
  /** The row holding the slugged name, or null when nothing does. */
  existing: { ado_target?: Record<string, unknown> | null } | null;
  /** What the caller typed, before slugging. */
  requested: string;
  /** What it slugs to — the name that would be created. */
  project: string;
}): CreateDecision {
  if (!input.existing) return "create";
  // A target with no `project` in it is not a target: an Azure DevOps setup
  // that half-succeeded leaves the project incomplete, not taken.
  const target = input.existing.ado_target as { project?: string } | null | undefined;
  if (target?.project) return "exists";
  return input.requested === input.project ? "complete" : "slug_collision";
}
