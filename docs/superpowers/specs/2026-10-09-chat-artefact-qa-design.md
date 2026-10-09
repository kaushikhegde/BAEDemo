# Chat answers questions about generated artefacts — design

Date: 2026-10-09 · Branch: `bae-systems`

## Problem

The chat can run stages and request revisions, but it cannot answer questions
about what a stage produced. The system prompt tells Gemini to "answer
questions in text", yet Gemini never sees the capability map, personas, stories
or any other artefact, so it guesses.

The cause is structural: every chat tool is one-way. Gemini emits a `tool_use`,
the browser (`src/App.tsx`) executes it and renders the result, and the result
never returns to the model. There is no way for the model to read a file and
then answer from it.

## Goal

- Ask about any generated artefact in the chat and get an answer taken from
  the real file, naming the item it came from.
- When an answer shows a gap, the chat offers a change, and the user starts it
  with one click.
- A revision never starts from a misread sentence: the user confirms it first.

## Decisions (agreed in chat)

- **Scope: every artefact.** Project level (capabilities, personas) and feature
  level (requirements, ui, datamodel, architecture, qa, design).
- **Approach: a server-side read tool** that Gemini can call, with its result
  fed back to the model before it answers. Rejected: pasting every artefact
  into the prompt (about 80k tokens, and long prompts already cause Gemini's
  empty-turn failure, see `server/llm.ts`), and sending questions to the Claude
  specialist (minutes and dollars per question).
- **Revisions need a click.** `revise_artefact` shows a confirmation card
  instead of starting at once.

## Design

### 1. `server/artefact-reader.ts` (new)

`readArtefact({ project, feature, artefact })` returns
`{ state: "ok", file, content, truncated } | { state: "not_generated", file } | { state: "invalid", reason }`.

The artefact maps to one readable file:

| artefact | level | file |
|---|---|---|
| `capabilities` | project | `solutions/Capabilities/outputs/capability-process.md` |
| `personas` | project | `solutions/Experience/outputs/personas-journeys.md` |
| `requirements` | feature | `outputs/product-summary.md` + `outputs/stories.md` |
| `ui` | feature | `solutions/UI/outputs/mockups.json` |
| `datamodel` | feature | `solutions/DataModel/outputs/salesforce-data-model.md` |
| `architecture` | feature | `solutions/Architecture/outputs/solution-architecture.md` |
| `qa` | feature | `solutions/QA/outputs/test-cases.md` |
| `design` | feature | `solutions/Design/outputs/solution-design.md` |

Safety rules:

- Only the fixed table above. Never a path supplied by the model.
- Project and feature names must match `^[A-Za-z0-9][A-Za-z0-9 _.-]*$` and
  contain no `..`. A feature must not be a reserved name.
- A feature-level artefact without a feature is `invalid`, and the model is
  told to ask which feature.
- The project must appear in `store.available(token)`, so a user can only read
  projects they can already see.
- The content is capped at 200 KB, and `truncated: true` says so.

The `.md` files are used rather than the `.json` ones because they hold the same
content in a form the model reads more reliably, at about half the size.

### 2. A read loop in `chat()` (`server/llm.ts`)

- Add a `read_artefact` tool declaration with `project`, `feature?` and
  `artefact`.
- After each model turn, if the only tool calls are `read_artefact`, run them
  on the server and send the results back as `functionResponse` parts on the
  same chat session. Repeat at most 3 rounds, then send one more turn telling
  the model to answer with what it has.
- A turn whose tool calls are all `read_artefact` continues the loop; any text
  in that turn is discarded, because the answer comes after the read.
- A turn with any other tool call (trigger, revise, delete, and so on) ends the
  loop and goes to the browser exactly as today, with any `read_artefact` calls
  in it removed.
- The compact-prompt fallback uses the same loop.
- Only the final turn is returned and recorded. The file contents are not
  stored in the chat history, so a later question reads the file again. This
  keeps the history small.

### 3. Prompt rules (`buildSystemPrompt`)

- For a question about an artefact, call `read_artefact` first and answer only
  from what it returns.
- Name the item the answer comes from: persona name and abbreviation,
  capability ID, story number, test ID.
- If the thing is not in the file, say so. Never fill the gap from general
  knowledge.
- If the result is `not_generated`, say the artefact has not been made and
  offer to generate it.
- If the answer reveals a gap, offer the change in one line ("Want me to add
  it?"). On a yes, call `revise_artefact` with the user's own words plus the
  gap the answer found.
- Keep the existing rule: a question is not a revision.

### 4. Confirmation card for revisions (`src/`)

- `UIMessage` gains `kind: "proposal"` and
  `proposal: { project, feature?, artefact, instruction, state: "pending" | "started" | "cancelled", issue? }`.
- The `revise_artefact` branch in `App.tsx` pushes a proposal message instead of
  calling `reviseArtefact` straight away.
- `MessageBubble.tsx` renders the card: what will change, the instruction in
  quotes, "about 15 min · about $1.50", and **Start change** / **Cancel**.
- **Start change** runs the existing `reviseArtefact` path (issue, Activity tab,
  gate) and sets `state: "started"` with the issue identifier. **Cancel** sets
  `state: "cancelled"`. Both disable the buttons, and the state survives a
  reload because messages are already persisted.
- The model-side `revise_artefact` tool is unchanged, so
  `npm run check:routing` should still pass.

### 5. Cost and speed

A question reads one to three files of 10–70 KB. On Gemini 2.5 Flash that is
under one cent and a few seconds. No Claude run, no workflow, no issue.

## Testing

- `server/artefact-reader.test.ts`: each artefact maps to its file;
  `not_generated` when missing; rejects `..`, reserved names, unknown
  artefacts and projects outside `store.available`; truncation at 200 KB.
- `server/llm-read-loop.test.ts` with a fake Gemini session: read then answer;
  three rounds then forced answer; a non-read tool ends the loop and is
  returned untouched.
- `npm run check:routing` and the full chatbot suite.
- Chrome, on BAE: ask three questions (a persona, a capability, a gap), check
  that each answer names real items; then ask for a change, check the card
  appears, and click **Cancel** so nothing is spent.

## Out of scope

- Answering from source documents (the client's uploads). This is about
  generated artefacts only.
- Searching across several projects in one question.
- Editing artefacts directly from the chat without the specialist and gate.

## Docs to update

`docs/chatbot.md` (new tool, read loop, proposal card).
