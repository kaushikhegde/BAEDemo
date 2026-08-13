# Legacy React scaffold (retired)

These two scripts were the Developer agent's build path until the companion app
moved to a single self-contained HTML page. They are kept here rather than
deleted so the React path can be restored if a client genuinely needs a running
React application rather than a static deliverable.

| Script | What it did |
|---|---|
| `scaffold-app.mjs` | Created `generated-apps/<project>-<feature>/` from the Vite `react-ts` template, installed deps, added Tailwind + shadcn/ui, allocated a free port, launched `npm run dev` **detached**, polled until the dev URL answered, and wrote a registry entry with `{port, devUrl, pid}`. |
| `stop-app.mjs` | Killed that pid and cleared the running state from the registry. |

## Why they were retired

The deliverable is a **companion app** — something a consultant hands to a
client to explain the solution. That is a document, not a running program. The
React path cost an `npm install` per feature (minutes), a long-lived detached
process per feature, a port allocation, pid tracking, and a dev server that had
to still be alive whenever anyone opened the preview. A static page has none of
that: it renders in about a second, it survives a machine restart, it can be
emailed, and it opens from a file.

It is also produced deterministically now. `scripts/render-companion-app.mjs`
reads the feature's own artefacts and emits the page, so every run looks the
same — the same reasoning behind `render-capability-map.mjs`.

## What replaced them

- `scripts/render-companion-app.mjs <project> <feature>` — writes
  `generated-apps/<project>-<feature>/index.html` and the registry entry.
- `GET /api/companion-app/:project/:feature` in the chatbot serves that file.
- The registry entry keeps `devUrl` (now pointing at that route) so the preview
  iframe and `scripts/audit-a11y.mjs` continue to work unchanged.

## Restoring the React path

1. Move both scripts back to `scripts/`.
2. In `scyne-chatbot/server/index.ts`, point the `/api/preview/:project/:feature/:action`
   handler's `runHelper` calls back at `scaffold-app.mjs` / `stop-app.mjs`.
3. In `agent-instructions/ui.json`, restore the Developer's build step to call
   `node scripts/scaffold-app.mjs <project> <feature>`.
4. Re-run `npm run bootstrap` to push the changed Developer bundle.

The registry format is a superset of what these scripts wrote — they set
`port`/`pid`, the renderer sets `htmlPath`/`kind`. Nothing else reads those
fields conditionally, so both can coexist during a transition.
