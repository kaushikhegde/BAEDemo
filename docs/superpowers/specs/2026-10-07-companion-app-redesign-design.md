# Companion app redesign — static rewrite, journey grid, swimlanes

Date: 2026-10-07 · Status: approved in brainstorming (journey A, swimlane B,
whole-app polish, full static rewrite).

## Why

The BAE client rejected the companion app's look. Two things were named: the
journey view (cramped side column, "—" filler cells, clipped columns, a curve
that is hard to read, red on every surface) and the absence of a process
swimlane diagram. Polish is the priority.

## Decisions

| | |
|---|---|
| Journey | **Stage grid**: stages across the top, rows Doing / Thinking / Feeling (today vs tomorrow curve) / Pain / Opportunity. Empty cells stay blank. Sticky row labels, horizontal scroll past the viewport. Moments that matter get a ★ badge and a section below with why + design response. Metrics as pills. |
| Swimlane | **Polished BPMN**: lanes = roles (badge + name), start circle, task boxes, amber gateway diamonds, Yes/No pills, green/red end states, dashed system tasks, red `!` pain badge (hover = reason), SLA chips. One per L1 phase, current state only. Clicking a task highlights its activity card. |
| Data | The **capability-process-map skill writes it** as `flows` in `process-model.json`. Optional, so old projects still render (no swimlane, cards only). |
| Scope | Whole app — one visual system for every tab, light + dark, print. |
| Build | **Full static rewrite**: Node renders every view to HTML; a ~250-line client script only routes, toggles, filters and searches. Still one self-contained file, zero network requests. |

## `flows` contract (process-model.json)

```json
"flows": [{
  "l1": "Requisition & Approval",
  "lanes": ["Requester (REQ)", "System", "Approving Manager (AM)", "Buyer (BUY)"],
  "nodes": [
    {"id": "start", "type": "start", "lane": "Requester (REQ)", "label": "Need identified"},
    {"id": "t1", "type": "task", "lane": "Requester (REQ)", "label": "Check catalogue or BPA",
     "activity": "<exact l3 of an activity in this l1>", "pain": "optional, <=140 chars", "sla": "optional, <=60 chars"},
    {"id": "g1", "type": "gateway", "lane": "Requester (REQ)", "label": "Covered by catalogue?"},
    "… (abridged — t2, t3 and the rest of the flow)",
    {"id": "end-ok", "type": "end", "lane": "Buyer (BUY)", "label": "Ready for PO", "outcome": "good"}
  ],
  "edges": [{"from": "start", "to": "t1"}, {"from": "g1", "to": "t2", "label": "Yes"}]
}]
```

Rules (enforced by `render-capability-map.mjs --validate-only`): `l1` matches an
activity phase and appears once; lanes non-empty and unique; every node's lane
is listed; ids unique; types `start|task|gateway|end`; exactly one `start`, at
least one `end`; edges reference existing nodes; every node reachable from the
start; a gateway has 2+ outgoing edges; a start has none incoming, an end none
outgoing; `activity`, when present, names an `l3` in the same `l1`;
`outcome` is `good|bad` (default `good`); labels <= 80 chars. Loops are allowed.

The skill writes `flows` first and derives §5's Mermaid from it, so the wiki
document and the app cannot disagree. Revision mode converts an existing §5
into `flows` without touching anything else.

## Code layout

`scripts/render-companion-app.mjs` becomes a shim that calls
`scripts/companion/render.mjs`. Same CLI, output path, `registry.json` fields,
final-stdout-JSON contract, and `nothing to render` error text.

```
scripts/companion/
  render.mjs        main: load → views → index.html + registry
  load.mjs          inputs (moved unchanged): theme, artefacts, collections,
                    images, parseStory, withoutSourceRefs, mdToHtml, mermaid
  html.mjs          html`` tagged template with auto-escape; raw() opt-out
  swimlane.mjs      flow → layout → SVG string (pure, unit tested)
  views/*.mjs       shell, personas, journey, capabilities, process, feature
  styles.css        design tokens + components, inlined
  client.js         routing, sub-tabs, dialogs, slide-over, search, theme, print
```

Routes: `#/<tab>` plus deep links `#/<tab>/<view>` (journey id, phase slug,
feature slug). Print expands every view. Dark mode follows the OS until the
toggle is used (remembered per browser, try/catch).

## Testing

- `scripts/companion/swimlane.test.mjs`: layout ranks, lane placement, no two
  boxes overlap, back-edges handled, every edge drawn, escaping.
- `test/flows-validate.test.mjs`: each validator rule accepts/refuses.
- `test/companion-render.test.mjs`: render BAE fixture → contains every tab,
  swimlane only when `flows` exist, no `—` filler cells, no external URLs,
  registry entry shape.
- `test/companion-contrast.test.mjs` repointed at `styles.css`.
- Visual check in the browser, light and dark, both swimlane and journey.

## Rollout

1. Ship code. 2. `revise-capabilities` on BAE ("add flows from §5") — one AI
run, then the human gate. 3. Re-render the app, approve its gate.
