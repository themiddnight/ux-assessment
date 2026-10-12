# Decide, result and settings — design

Date: 2026-10-12. Status: approved in chat. SPEC decision: D35 (amends D15 and D20).

## Problem

After a run, the developer labels every finding by hand: `valid`, `not real` or `won't fix`. Two
things make this slow.

- One label answers two questions: "is this real?" and "will we fix it?". The first is mostly
  settled by triage. The second is a product decision, and it is the slow one.
- Findings are referred to by id alone (`F-03`) in several places, so the developer has to keep
  the report open to know what an id means.

## Goals

1. An agent proposes, per finding, whether to fix it, keep it or ask the developer, using the
   product documents and the source.
2. The developer reviews only the findings the agent could not decide.
3. One command shows the state of every finding as a table.
4. An id never appears without its title where a person reads it.

Not in this round: a fix command, a separate verify skill, and an end-to-end automatic mode. They
depend on how well the decide step separates the three outcomes on real runs.

## Decisions

A decision belongs to one finding in one run.

| value | when | effect |
|---|---|---|
| `fix` | No document or code says the behavior is on purpose, and the fix does not change what the app is for. | Goes to the fix list. |
| `keep` | A document or the code says the behavior is on purpose, and the persona still reached its goal. | Not fixed. Needs a cited source. |
| `ask` | On purpose but it cost a persona the goal; the documents and the code disagree; or the fixes differ as product choices. | Waits for the developer. |

Rules:

- `keep` needs a source: a file, a line and a quote found in that file. Without one it becomes `ask`.
  A document says what was intended. It does not say the intent is right.
- An agent's `keep` never hides a finding. It does not change the ledger status and does not
  suppress the finding in later runs.
- A developer label wins. A finding with a label (`valid`, `not real`, `won't fix`) is not decided
  again: `valid` counts as `fix`, `won't fix` as `keep`, both `by: human`.
- Precision is still computed from developer labels only. Accepting the agent's decisions writes
  no label.

## Data

### `runs/<run>/decisions.yaml`

Written by the decide agent, then checked and rewritten by `decide.mjs record`.

```yaml
run: 2026-10-12
decided_at: 2026-10-12T09:30:00.000Z
checked: true                 # written by `record`; `ledger.mjs sync` ignores a file without it
decisions:
  - id: F-03
    decision: keep            # fix | keep | ask
    reason: "The PRD requires sign-up before export."
    sources:                  # required for keep
      - {path: docs/prd.md, line: 42, quote: "Export is for signed-in users"}
    options: []               # ask: the choices the developer has, one line each
    guard: null               # set by `record` when it changed the decision, e.g. "keep without a source: counted as ask"
```

`path` is relative to the project root, with forward slashes. `reason` and `options` are in the
report language, because the developer reads them in the report and on the question cards. An
option that leaves the app as it is starts with the literal marker `Keep:`.

### `findings.yaml` (triage)

One new field per finding:

```yaml
title_local: "ไม่มีอะไรบอกว่าเสียงกำลังเล่น"   # the title in the report language; the same as `title` for an English report
```

`title` stays English, as every internal file does. The report, `feedback.md`, the result table
and every message to the developer use `title_local`.

### `ledger.yaml`

- Each sighting gains `title_local`. Each finding gains `title_local` (from its last sighting,
  falling back to `title`).
- Each finding gains `decision`: `{value, by, reason, sources, options, run}` or `null`.
  - A developer label gives `{value: fix | keep, by: human}` (`not real` gives `null`).
  - Otherwise it is the decision in the latest run (by run order) that has one for this id, with
    `by: agent`.
- `computeStatus` does not read `decision`.

### `feedback.md`

`decide.mjs record` adds a `suggest:` segment before `label:` on each line of the run's section,
and replaces an earlier one:

```markdown
- F-03 ไม่มีอะไรบอกว่าเสียงกำลังเล่น — suggest: keep (docs/prd.md:42) — label: ? — note:
- F-04 … — suggest: fix — label: ? — note:
- F-05 … — suggest: ask — label: ? — note:
```

`parseFeedback` already reads such a line: everything between the id and `— label:` is ignored.
Triage writes the line with `title_local`.

### `config.yaml`

```yaml
product_docs: [docs/, SPEC.md]   # files, folders or globs, relative to the project; optional
decide: on                       # on | off; default on
models: {claude: {decide: opus}} # optional, like the other roles
```

`product_docs` unset means the default list: `AGENTS.md`, `CLAUDE.md`, `README*`, `SPEC.md`,
`PRD*`, `docs/**`, `.ux-assessment/docs/**`. A folder means every document under it. Documents are files ending in `.md`,
`.mdx`, `.txt` or `.rst`. `node_modules`, `.git` and `.ux-assessment` are never read, except `.ux-assessment/docs/`: a
document from outside the repo (a drive, a wiki, a ticket) is saved there, so that the decide
agent can read it and a `keep` can cite it. The decide skill offers to save one that was opened
earlier in the same conversation; unattended runs save nothing. An absolute
path outside the project is allowed, because the developer wrote it. At most 200 files; beyond
that, a warning names how many were left out.

### Asking for a document

The skill asks for a product document only when it would change the result, and once per project.

- Intake question 1.3 sits on the Round 1 card, and only when `decide.mjs docs` finds nothing but
  `README*`, `AGENTS.md` and `CLAUDE.md`. A path in the project goes into `product_docs`; a
  document from elsewhere is saved under `.ux-assessment/docs/`. The answer is in the charter's
  intake record, and later runs reuse the charter, so it is not asked again.
- Quick mode does not ask: it says in one line that no document was found.
- Unattended runs assume there is none and save nothing.
- After decide, when no document was found and some findings are `ask`, one line says that a
  requirements document would let more of them be decided.

## Driver

### `driver/decide.mjs`

```
node decide.mjs docs <project>                  JSON {enabled, patterns, files, warnings}
node decide.mjs todo <project> --run <name>     JSON {run, findings: [...], docs: [...]}
node decide.mjs record <project> --run <name>   checks and rewrites decisions.yaml, updates feedback.md
node decide.mjs table <project> --run <name>    the report's Decisions section, as Markdown
```

Exports (pure functions take data; the CLI does the file work):

```js
export const DEFAULT_DOCS;                                  // the default pattern list
export function resolveDocs(project, patterns);             // → {files: string[], warnings: string[]}
export function decideConfig(project);                      // → {enabled: boolean, patterns: string[]}
export function todoFindings(project, run);                 // → finding records to decide
export function checkDecisions({ decisions, todo, readFile }); // → {decisions, warnings}
export function suggestText(decision);                      // → "keep (docs/prd.md:42)" | "fix" | "ask"
export function withSuggestions(feedbackText, run, decisions); // → feedback.md text
export function decisionsTable(decisions, titles);          // → Markdown
```

`todo` lists the findings of that run with `kind: ux`, not `suppressed`, and no developer label in
the ledger. Each carries `id`, `title`, `title_local`, `severity`, `confidence`, `personas`,
`what_happened`, `why_it_matters`, `suggested_fix`, `code_pointer`, `intended` and the absolute
paths of its screenshots.

`record` guards, in the manner of `verify.mjs record`. Each one sets `guard` and prints a warning:

| input | result |
|---|---|
| an id that is not in `todo` | dropped |
| a `todo` finding with no decision | added as `ask`, guard "no decision returned" |
| a `decision` that is not `fix`, `keep` or `ask` | `ask` |
| `keep` with no source | `ask` |
| a source whose file does not exist, or is neither inside the project nor a resolved product document | source dropped |
| a source whose quote is not in the file (whitespace-normalized) | source dropped |
| a source whose quote is in the file at another line | `line` corrected, no guard |
| `keep` whose sources were all dropped | `ask` |
| a source under `.ux-assessment/` other than `charter.md` and `docs/` | source dropped: a run's own files are not evidence |
| an `ask` with fewer than two options | the default two: "Fix it", "Keep: leave it as it is" |
| an option that YAML read as a map (`- Keep: …` unquoted) | turned back into text |

Paths are compared by real path, so a symlink cannot carry a source out of the project.
`sync` also drops a decision whose id is not among that run's findings, which a re-triage can
leave behind.

`record` is idempotent: running it twice gives the same files.

`table` prints three groups in this order: Needs you (`ask`, with options), To fix, Kept (with the
source as `path:line`). Every row starts with `F-03 · <title_local>`.

### `driver/ledger.mjs`

- `sync` reads `title_local` and `decisions.yaml` as described under Data.
- `status` and `table` print `title_local`.
- New command `board`:

```
node ledger.mjs board <project>           Markdown
node ledger.mjs board <project> --json    the same data as JSON
```

```js
export function boardGroups(ledger);   // → [{key, rows: [...]}], pure
export function boardMarkdown(groups); // → string
```

A `ux` finding goes into the first group whose rule it meets:

| key | rule |
|---|---|
| `closed` | status `fixed`, `not_real` or `suppressed` |
| `awaiting_check` | status `not_seen` |
| `needs_you` | status `needs_review`, or decision `ask` |
| `to_fix` | decision `fix` |
| `kept` | decision `keep` |
| `undecided` | everything else |

The Markdown prints the groups as `needs_you`, `to_fix`, `kept`, `undecided`, `awaiting_check`, then
`closed` as one line of counts. Columns: Finding (`F-03 · title`), Severity, Status (plain words),
Decision (value, `by`, and the source, or how many options an `ask` has), Last seen (a link to
`runs/<run>/report.md`). Rows are ordered by severity, then id. An empty group is left out. The
last line says what to do next for the groups that have rows.

`agent_error` and `env_error` records are not on the board.

### `driver/models.mjs`, `driver/usage.mjs`

- `decide` is a Claude role with default `opus`, and may be set in `config.yaml`.
- `decide` joins `ROLE_ORDER` between `triage` and the end. The estimate shows a `decide` row as
  "not measured" until a dogfood run gives coefficients.

## Agent and rules

- `agents/decide.md`: tools `Read, Grep, Glob, Bash, Write`, model `opus`. One agent decides all
  findings of a run, so the documents are read once. Its briefing gives the project root, the
  plugin root, the run folder, the output of `decide.mjs todo`, and the paths of the charter and
  `knowledge/decide.md`. It writes `decisions.yaml` and replies with counts.
- `knowledge/decide.md`: the three outcomes, the source rule, what counts as a product choice,
  and the file format. It also says what the agent must not do: change a finding, drop a finding,
  or quote text it did not read.
- Decide happens after discovery, so knowledge isolation does not limit what it reads. Nothing it
  writes goes into a persona briefing.

## Skills

Claude Code skills, each in `skills/<name>/SKILL.md`:

| command | does |
|---|---|
| `/ux-assessment:decide` | Runs decide on the last persona run, or the run named in the arguments. |
| `/ux-assessment:result` | Runs `ledger.mjs sync`, then shows `ledger.mjs board`. Read-only. |
| `/ux-assessment:settings` | Shows `config.yaml` and changes `product_docs`, `decide` and the models through question cards. |

Changes to `skills/ux-assessment/SKILL.md`:

- **State menu** gains **Show results**, **Decide** and **Settings**. Each follows the matching
  skill file, so Codex reaches the same steps through the main entry.
- **New step 9b, Decide**, after triage. It runs unless `decide.mjs docs` says `enabled: false`,
  and it runs in unattended mode too. Steps: `decide.mjs todo` → dispatch `ux-assessment:decide` →
  `decide.mjs record` → `ledger.mjs sync` → append the output of `decide.mjs table` to `report.md`
  under `## Decisions`.
- **Step 10** gives the counts per decision and lists the `ask` findings.
- **Step 11, labels**, becomes:
  1. The `ask` findings first, one question each, with the agent's options as the choices.
  2. One card for the rest: **Accept all** (recommended) · **Review one by one**. Accept all
     writes no label. Review one by one is the old flow, with the agent's decision as the
     recommended choice.
  3. For `keep` decisions with a source, one card: **Add these to Intended behaviors** · **No**.
     Each added line ends `— source: decide F-07 (docs/prd.md:42)`. Unattended runs never edit the
     charter.
- **The id rule.** Wherever a step tells the developer about a finding, it writes
  `F-03 · <title_local>`.

`codex/skills/ux-assessment/SKILL.md` gets the same menu entries and the decide step. Codex has
no decide subagent: the main session follows `knowledge/decide.md` and writes `decisions.yaml`
itself. The install script links one skill for Codex and is not changed.

`knowledge/triage.md` and `agents/triage.md`:

- The finding record gains `title_local`.
- The report writes `F-03 · <title_local>` in every place that names a finding: the Summary, the
  per-persona journeys, the "What people expected" table and every cross-reference.
- `feedback.md` lines use `title_local`.

`knowledge/verify.md` and section V: the verify summary names findings as `F-03 · <title_local>`.

## Tests

- `driver/test/decide.test.mjs`: `resolveDocs` (defaults, folder, glob, excluded folders, outside
  path, the 200 cap), every `record` guard, `record` twice gives the same files, `withSuggestions`
  (adds, replaces, leaves other runs alone, keeps labels and notes), `decisionsTable`.
- `driver/test/ledger.test.mjs`, `ledger-sync.test.mjs`: `title_local`, `decision` from a run, a
  later run's decision wins, a label wins, `computeStatus` unchanged, `parseFeedback` reads a line
  with `suggest:`.
- `driver/test/board.test.mjs`: each group rule, the order, an empty group, the counts line.
- `driver/test/decide-agent.test.mjs`: the agent's frontmatter and the three outcome names in
  `agents/decide.md` and `knowledge/decide.md`.
- `models.test.mjs`, `usage-estimate.test.mjs`: the `decide` role.
- `docs.test.mjs` already checks every `node …mjs` command in the published docs against the
  scripts.

Verification on the real artifact: a sample project with a PRD and a run whose findings cover the
three outcomes, plus one finding the PRD does not mention. An agent follows `agents/decide.md` on
it. Then `record`, `sync` and `board` run, and the ledger, `feedback.md` and the table are read.

## Unknowns

- The tokens a decide agent uses are not measured.
- How often the agent returns `ask` on a real project is not known. It decides whether the next
  round builds an automatic mode.
