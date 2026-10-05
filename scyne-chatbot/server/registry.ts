// Which companion-app registry entry a project has.
//
// The app stage renders in a scratch tree and its output is harvested into the
// DOCUMENT STORE, which is also where `/api/companion-app/:project/` serves the
// page from. The install's own `generated-apps/registry.json` is only written by
// a render run by hand on this machine. So the stored registry is the record,
// and the disk copy is the fallback for an install with no store.

export type RegistryLookup =
  | { error: null; entry: Record<string, unknown> }
  | { error: "no_registry" | "no_entry"; entry: null };

const parse = (raw: string | null): Record<string, any> | null => {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

export function pickRegistryEntry(
  stored: string | null, disk: string | null, project: string,
): RegistryLookup {
  const fromStore = parse(stored);
  const fromDisk = parse(disk);
  if (!fromStore && !fromDisk) return { error: "no_registry", entry: null };
  const entry = fromStore?.[project] ?? fromDisk?.[project];
  if (!entry) return { error: "no_entry", entry: null };
  return { error: null, entry };
}
