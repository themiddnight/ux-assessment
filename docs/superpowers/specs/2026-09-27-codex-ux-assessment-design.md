# Local Claude and Codex UX assessment

## Decision

Keep the existing Claude Code plugin, browser driver, and knowledge files. Add a
Codex skill and a local Codex persona runner. The first release targets this Mac.
The Codex skill follows the same intake, charter, planning, triage, and report
contract, while the runner handles the one boundary that cannot be reproduced by
ordinary Codex subagents: a persona may see only screenshots and the `act` and
`end_session` tools.

## Persona boundary

The orchestrating Codex process launches a browser session through the existing
`Session` driver, then serves a short-lived MCP endpoint bound to `127.0.0.1`.
That endpoint registers only `act` and `end_session` for one session ID. The
persona is a separate `codex exec` process with an empty temporary working
directory, no user configuration, and a macOS sandbox profile denying reads of
the app and plugin trees and outbound localhost connections except to its MCP
endpoint. Its prompt consists only of the shared persona instructions and the
briefing defined by `knowledge/personas.md`.

The parent owns browser lifecycle, state, signals, and the run folder. It closes
the bridge and browser after the persona exits, including failures. A token in
the bridge URL prevents blind local requests from guessing the endpoint. The
runner writes its output and private logs with owner-only permissions. No
harness tool is registered on the persona endpoint.

## Workflow

The Codex skill maps the Claude skill's steps to Codex tools and the runner. It
uses the same `knowledge/` content and output format under `.ux-assessment/`.
Authentication setup remains an orchestrator action; saved state is passed to
`Session.start`, never to the persona process. The runner accepts one JSON job
containing the session options and persona briefing and returns a JSON summary
with the final driver signals and Codex result. Runs can be sequenced or started
concurrently, capped by the existing `max_parallel` rule.

## Limits

This release requires macOS `sandbox-exec`, the local Codex CLI, Node 20+, and a
Chromium install for Playwright. The isolated runner is for local app URLs;
remote staging targets need a separately tested network policy. Another process
running under the same operating-system account can inspect process arguments;
that local adversary remains outside this boundary's threat model. Claude's
plugin remains available without using the Codex runner.

## Acceptance

- Existing Claude MCP tests still pass.
- The Codex bridge exposes exactly `act` and `end_session` and rejects other
  session IDs and unauthenticated requests.
- A sandboxed process cannot read the app/plugin trees or connect to the app
  port, while it can reach the bridge.
- A real Codex persona completes a browser session through the bridge and the
  parent records truthful signals.
- The maker app can be assessed with an authenticated returning persona and a report;
  any remaining Guided or Claude CLI gap is reported explicitly.
