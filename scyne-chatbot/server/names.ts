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
