---
description: Drive the Scyne pipeline and the large-document plane — run or revise a stage, check an issue, approve a gate, ingest a huge file, report spend.
argument-hint: "[verb] — e.g. run datamodel · status SCY-41 · upload ~/contract.pdf · gate approve g_8f21 · spend --by feature"
---

Load the `scyne` skill and dispatch on the verb in `$ARGUMENTS`.

The skill body is the single source of truth for what each verb does, which MCP
tool serves it, and the rules that bound all of them — above all the one that
matters: **never read a document yourself.** It lives at
`skills/scyne/SKILL.md` in this plugin, and the same text is served as the MCP
prompt `scyne` by the `scyne-workspace` server, so all three surfaces stay in
step by construction rather than by anybody remembering.

If `$ARGUMENTS` is empty: report the pinned target if there is one, then run
`stages` and `list_issues { open: true }` and summarise what is runnable and
what is waiting on a person.

If the verb is not one the skill lists: say so and show the table. Never guess
at the nearest one — `run` and `revise` both cost real money and are not
interchangeable.
