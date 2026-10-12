---
name: result
description: Show where every finding of a project's ux-assessment runs stands, as one table — what needs the developer, what is to fix, what was kept, what awaits a check. Use when the user invokes /ux-assessment:result, or asks for the results, the status or the list of findings of their simulated-user tests. Read-only.
---

# ux-assessment: result

Plugin root = two directories above this skill's base directory; call it `$PLUGIN`.
`$PLUGIN` is a placeholder: write the absolute path in its place in every command; it is not a
shell variable (PowerShell would expand it to nothing). The base directory may be reached through
a link, so take its real path first:
`node -p "require('fs').realpathSync(process.argv[1])" "<base directory>"`.
When the main skill (`$PLUGIN/skills/ux-assessment/SKILL.md`) sent you here, `$PLUGIN` is already
known. This skill opens no browser, so it runs no dependency check.

Talk to the user in **their** language, without UX vocabulary. The project is the current working
directory. Wherever you tell the user about a finding, write its id with its title:
`F-03 · <title_local>`. Never an id alone.

This skill changes no label and no decision (the sync in step 2 only brings `ledger.yaml` up to
date with the run folders and `feedback.md`), and it asks no question, so it runs
the same way unattended.

## Steps

1. **Anything yet?** If `<project>/.ux-assessment/` does not exist, tell the user there are no
   results yet and that `/ux-assessment` runs the first test. Stop. Do not create the folder.
2. **Sync.** Run `node "$PLUGIN/driver/ledger.mjs" sync <project>`. Tell the user each stderr
   warning in plain words (for example an unknown label in `feedback.md`).
3. **Board.** Run `node "$PLUGIN/driver/ledger.mjs" board <project>`. It prints Markdown: one table
   per group (needs you, to fix, kept, undecided, awaiting a check), then one line of counts for
   the closed findings, then a line about what to do next. When it prints no finding, say there
   are no results yet, as in step 1, and stop.
4. **Show it.** Show the tables to the user. Translate the group headings, the column headings,
   the status words and the last line into the user's language. Never change an id, a title, a
   path, a link or a count, and never drop or reorder a row.
5. **Next step.** End with the one step that fits what the board shows, first match wins:
   - rows under "needs you" whose decision is `ask`: `/ux-assessment` → Label findings, where
     they answer those; rows there whose status says the screen changed: Verify fixes, which
     checks them again;
   - rows that are undecided: Decide on the run in their Last seen column
     (`/ux-assessment:decide <run folder name>`; without a name it takes the latest run only).
     A row marked "(design)" is the exception: Decide refuses a design run, so `/ux-assessment` →
     Label findings is the step for it;
   - rows to fix: fix them, then `/ux-assessment` → Verify fixes;
   - rows awaiting a check: Verify fixes once more, because a finding counts as fixed only after
     two separate checks did not see it;
   - nothing open: say so.
