# Cost coefficients (tokens)

`node driver/usage.mjs estimate` reads the yaml block at the end of this file. Figures are tokens.
`input` includes cache writes; `output` includes reasoning tokens. Per-step figures scale with the
number of steps (low: 8 steps per persona or verifier, or the cap if lower; high: the cap, 15 for a
verifier). Fixed figures are a measured low–high range for one session. `null` means not measured:
the estimate prints "not measured" for that row and leaves it out of the dollar line.

The estimate prices the default role models and ignores model overrides in `config.yaml` (phase 3).

Update these figures from `node driver/usage.mjs report <run folder>` after a measured run, and
say which run in the table below.

Known undercount: the Claude hook reads output tokens from Claude Code transcripts, and those carry
less than was billed. On the timer app (2026-09-29) the transcripts held 57 % of the output that
`claude -p` `modelUsage` billed (46.9k of 82.7k), so the report's dollar line was 14 % low ($3.31
against $3.83). Input and cached input matched exactly. Output figures below come from `claude -p`
where one model maps to one role; otherwise they are marked as hook figures or bounds.

## Sources

| key | measured on | how |
|---|---|---|
| claude.persona | input, cached: the timer app, Guided unattended 2026-09-29, 6 personas, 51 steps, Sonnet. Output: the music app, one-persona rerun, 15 steps | input, cached: hook ÷ 51 (162k, 1.51M); output: `claude -p` `modelUsage` ÷ 15 (5.3k), because the hook's 4.5k for 51 steps is the transcript undercount |
| claude.verifier | the music app, 13 findings, ≤ 15 steps each, Sonnet | `claude -p`; per step = per finding ÷ 15 (36k, 709k, 6.3k per finding), so the high end equals one measured finding |
| claude.recon | — | not measured on its own (Opus, standard depth); the 2026-09-29 timer-app run reused the app profile, so no recon ran |
| claude.recon_quick | — | not measured on its own (only recon + 3 personas together: 92k–100k, 651k–1.09M, 16k–17k) |
| claude.triage | the guide app, the music app, a guide-app rerun, the timer app 2026-09-29, Opus | `claude -p`, four sessions (range); the timer-app run's triage was its only Opus session, so `modelUsage` gives its exact output (36.2k; the hook read 19.9k) |
| claude.orchestrator | Quick unattended, 3 personas, the guide and music apps; Guided unattended, 6 personas, the timer app 2026-09-29; Sonnet main session | `claude -p` main session `usage`; the timer-app run by the hook (130k, 1.52M exact). Output high end 43k ≥ 42.0k, the timer-app run's Sonnet output billed minus the persona hook output, an upper bound. An Opus main session costs more |
| claude.orchestrator_verify | verify of 13 findings, Sonnet main session | `claude -p` |
| codex.persona | the timer app 2026-09-29, `core` persona, 10 steps, gpt-6-sol medium | `codex exec --json` last `turn.completed`; per step = total ÷ 10 (26.4k input without cached, 245k cached, 2.9k output incl. 0.6k reasoning) |
| codex.verifier | — | not measured |
| codex.recon, codex.triage, codex.orchestrator | — | not measured: they run in the user's Codex main session. Source for a follow-up (spec open question 5): Codex rollout files under `CODEX_HOME/sessions` carry `token_count` events with `total_token_usage`; the envelope is unconfirmed |

## Coefficients

```yaml
claude:
  persona: {model: sonnet, per_step: {input: 3200, cached_input: 29500, output: 350}}
  verifier: {model: sonnet, per_step: {input: 2400, cached_input: 47300, output: 420}}
  recon: {model: opus, fixed: null}
  recon_quick: {model: sonnet, fixed: null}
  triage: {model: opus, fixed: {input: [60000, 143000], cached_input: [626000, 2340000], output: [20000, 36200]}}
  orchestrator: {model: sonnet, fixed: {input: [76000, 131000], cached_input: [916000, 1530000], output: [18000, 43000]}}
  orchestrator_verify: {model: sonnet, fixed: {input: [8000, 8000], cached_input: [1090000, 1090000], output: [4900, 4900]}}
codex:
  persona: {model: gpt-6-sol, per_step: {input: 2600, cached_input: 24500, output: 290}}
  verifier: {model: gpt-6-sol, per_step: null}
  recon: {model: null, fixed: null}
  recon_quick: {model: null, fixed: null}
  triage: {model: null, fixed: null}
  orchestrator: {model: null, fixed: null}
  orchestrator_verify: {model: null, fixed: null}
```
