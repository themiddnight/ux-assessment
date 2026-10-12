---
name: settings
description: Show and change a project's ux-assessment settings — which product documents the decide step reads, whether the decide step runs, and the model per role. Use when the user invokes /ux-assessment:settings, or asks to see or change the settings of their simulated-user tests. Needs a person to answer.
---

# ux-assessment: settings

Plugin root = two directories above this skill's base directory; call it `$PLUGIN`.
`$PLUGIN` is a placeholder: write the absolute path in its place in every command; it is not a
shell variable (PowerShell would expand it to nothing). The base directory may be reached through
a link, so take its real path first:
`node -p "require('fs').realpathSync(process.argv[1])" "<base directory>"`.
When the main skill (`$PLUGIN/skills/ux-assessment/SKILL.md`) sent you here, `$PLUGIN` is already
known. This skill opens no browser, so it runs no dependency check.

Talk to the user in **their** language, without UX vocabulary. The project is the current working
directory. The settings file is `<project>/.ux-assessment/config.yaml`.

**Unattended** (the arguments contain `unattended`, the user is away, or AskUserQuestion is not
among your tools): settings need a person. Say so and stop. Change nothing.

## 1. Show

If `<project>/.ux-assessment/` does not exist, tell the user that settings need a first run and
that `/ux-assessment` starts it. Stop. Do not create the folder.

Otherwise read `config.yaml` (it may be missing: then everything is at its default) and run:

- `node "$PLUGIN/driver/decide.mjs" docs <project>`: JSON with `enabled`, `patterns`, `files` and
  `warnings`;
- `node "$PLUGIN/driver/models.mjs" show <project>`: the model per role, with warnings on stderr.

Tell the user, in plain words:

- **Product documents.** The patterns in use, and whether they are the default list or the
  project's own `product_docs`. How many documents they match. Every line of `warnings`, for
  example a pattern that matched nothing, or documents left out beyond the limit of 200.
- **Decide step.** On or off (`enabled`). Off stops only the automatic step after a run;
  `/ux-assessment:decide` still works.
- **Models.** The model per role, and which ones the project overrides. Show any warning.
- **Parallel sessions.** `max_parallel` (3 when the file does not set it).

## 2. Ask what to change

One card: **Product documents** · **Decide on or off** · **Models** · **Nothing**. On Nothing, stop.

- **Product documents.** Ask for the paths as free text: files, folders or globs, relative to the
  project, separated by commas (for example `docs/, SPEC.md, PRD*`). A folder means every document
  under it. An empty answer goes back to the default list: remove the `product_docs` key. Write
  `product_docs` as a YAML list. Then run `decide.mjs docs <project>` again and show what matched:
  the count, and the files when there are ten or fewer. A pattern that matches nothing is
  reported to the user by name, never kept silently: ask **Fix it** (ask for the paths again) ·
  **Keep it anyway**.
- **Decide on or off.** Ask **On** (recommended) · **Off**. Write `decide: on` or `decide: off`.
- **Models.** Ask which role: on Claude Code `persona`, `verifier`, `recon`, `triage` or `decide`;
  on Codex `persona` or `verifier`. Then ask for the model (on Codex also the effort: `low`,
  `medium` or `high`), with **Back to the default** as one choice. Write it under `models`, in
  the shape `models: {claude: {decide: opus}, codex: {persona: {model: <name>, effort: medium}}}`,
  keeping the other roles already there. Back to the default removes that role's entry. Then run
  `models.mjs show <project>` again and show the new line and any warning it prints.

After a change, ask the card again, until the user picks Nothing.

## Writing `config.yaml`

- Change only the key the user chose: `product_docs`, `decide`, or the one role under `models`.
  Keep every other line and every comment as it is. Edit the line; do not rewrite the file.
- A key that is there only as a comment: add the real line below the comment.
- No `config.yaml` yet: tell the user the file does not exist, and ask **Create it** with only the
  chosen key · **Cancel**. The other settings stay at their defaults, and the next full run adds
  its own keys.
- After writing, read the file back and tell the user the line that changed.
