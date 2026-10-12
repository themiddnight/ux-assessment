---
name: decide
description: Propose what to do with each finding of a ux-assessment run — fix it, keep it as it is, or ask the developer — from the project's product documents and source. Use when the user invokes /ux-assessment:decide, or asks to decide, sort or pre-label the findings of a simulated-user test run. Takes an optional run folder name.
---

# ux-assessment: decide

Plugin root = two directories above this skill's base directory; call it `$PLUGIN`.
`$PLUGIN` is a placeholder: write the absolute path in its place in every command; it is not a
shell variable (PowerShell would expand it to nothing). The base directory may be reached through
a link, so take its real path first:
`node -p "require('fs').realpathSync(process.argv[1])" "<base directory>"`.
When the main skill (`$PLUGIN/skills/ux-assessment/SKILL.md`) sent you here, `$PLUGIN` is already
known. This skill opens no browser, so it runs no dependency check.

Talk to the user in **their** language, without UX vocabulary. Internal files in English. The
project is the current working directory; everything lives in `<project>/.ux-assessment/`.
Wherever you tell the user about a finding, write its id with its title: `F-03 · <title_local>`
(`title` when the finding has no `title_local`). Never an id alone.

After triage, one agent reads the product documents and the code and proposes one decision per
finding: `fix`, `keep` or `ask`. The rules are in `$PLUGIN/knowledge/decide.md`. A decision is a
proposal: it changes no label and no ledger status, and a `keep` hides nothing. Nothing this step
reads or writes ever goes into a persona briefing.

This skill asks no question, so it runs the same way unattended.

## Steps

1. **Run.** The run is the folder named in the arguments. Otherwise it is the latest folder under
   `<project>/.ux-assessment/runs/` that has `findings.yaml` and no `verify.yaml` (latest by
   `started_at` in its `run.json`, or by name when that is missing). If there is none, tell the
   user there is no test run to decide on yet and that `/ux-assessment` starts one. Stop.
2. **Switch and documents.** Run `node "$PLUGIN/driver/decide.mjs" docs <project>`. It prints JSON:
   `enabled`, `patterns`, `files`, `warnings`. Tell the user each warning in plain words.
   - `enabled: false` and the main skill's step 9b sent you here: say in one line that the decide
     step is turned off in the settings. Stop.
   - `enabled: false` and the user asked for this skill (`/ux-assessment:decide`, or Decide in the
     menu): go on. The explicit request overrides `decide: off`, which only stops the automatic
     step. Say so in one sentence.
   - `files` is empty: go on, and tell the user that no product documents were found, so the
     proposals rest on the code alone. `/ux-assessment:settings` sets where the documents are.
   **Documents opened in this conversation.** The decide agent starts with an empty context and
   reads files only, and a `keep` must cite a file. A product document that was opened earlier in
   this conversation from outside the project (a drive, a wiki page, a ticket) is therefore not
   used unless it is saved. When there is one, and you are attended, ask once: **Save for the
   decide step** · **No**. On yes, write each to `<project>/.ux-assessment/docs/<short-name>.md`:
   first the line `<!-- source: <where it came from> · saved: <date> -->`, then the text as it
   was, not a summary (for a very long document, the sections about how the app behaves, with a
   line saying what was left out). The default document list includes that folder; when the
   project sets its own `product_docs`, tell the user to add `.ux-assessment/docs/` to it. Then
   run `decide.mjs docs` again. The file is a copy from that date: say so. Unattended: save
   nothing, and say in the final message that those documents were not used.
3. **Active run.** Write the run folder's name as the only line of
   `<project>/.ux-assessment/active-run`, so the token hook counts the agent for this run.
4. **Sync.** Run `node "$PLUGIN/driver/ledger.mjs" sync <project>`. Show any stderr warning to the
   user.
5. **To do.** Run `node "$PLUGIN/driver/decide.mjs" todo <project> --run <name>`. It prints JSON:
   the findings to decide and the documents. When `findings` is empty, tell the user that nothing
   is left to decide (every finding of this run already has their label, or the run has none).
   Stop.
6. **Dispatch.** One Agent call: `subagent_type: "ux-assessment:decide"`, `run_in_background: false`.
   The prompt gives the project root, `$PLUGIN` (absolute), the run folder (absolute), the `todo`
   output verbatim, the path of `<project>/.ux-assessment/charter.md` and the path of
   `$PLUGIN/knowledge/decide.md`. Model: the `claude decide` line of
   `node "$PLUGIN/driver/models.mjs" show <project>`, under the main skill's "Models per role"
   rule (leave `model` out when it is `opus`, the agent's own model). The agent writes
   `<run folder>/decisions.yaml`.
   **Codex** has no decide agent: do this step yourself. Read `$PLUGIN/knowledge/decide.md` and
   follow it exactly: read the documents, the findings and the code, then write `decisions.yaml`.
7. **Record.** Run `node "$PLUGIN/driver/decide.mjs" record <project> --run <name>`. It checks every
   quote against its file, rewrites `decisions.yaml` and adds a `suggest:` part to this run's lines
   in `feedback.md`. Show the user each stderr warning. Then read `decisions.yaml`: every decision
   whose `guard` is not `null` was changed by the check. Name each of those findings to the user
   with what the guard says, in plain words.
8. **Sync.** Run `ledger.mjs sync <project>` again, so the decisions reach the ledger.
9. **Report.** Run `node "$PLUGIN/driver/decide.mjs" table <project> --run <name>`. In
   `<run folder>/report.md`, the section `## Decisions` holds that output, verbatim. If the report
   already has a `## Decisions` section, replace it, up to the next `## ` heading or the end of
   the file. Otherwise append it at the end. If the output starts with its own `## Decisions`
   heading, do not add a second one. Change nothing else in the report.
10. **Tell the user.** How many findings are to fix, how many stay as they are, and how many need
    their answer. List each `ask` finding as `F-03 · <title_local>` with the choice it needs, in
    one line. Say where the report is, and that these are proposals: `/ux-assessment` → Label
    findings is where they answer.
