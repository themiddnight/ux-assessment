# Security policy

ux-assessment runs simulated users (personas) played by AI models against your web app. Its core
promise is **isolation**: a persona sees only its briefing and the screen, and can act only through
two tools, `act` and `end_session`. It must never read your source code, files, environment or the
network outside the browser the harness drives.

## Report a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository
(https://github.com/themiddnight/ux-assessment/security/advisories/new). Do not open a public issue for
anything on the list below. Expect a first answer within 7 days.

Include the harness (Claude Code or Codex) and its version, the OS, `node --version`, and the
steps or the persona prompt that shows the problem. For Codex, add the output of
`node driver/codex-runner.mjs self-check --json --project <app repo>` when you can.

## What counts as a security issue

- A persona reaches anything beyond `act` and `end_session`: a shell, a file read or write, a
  network request that does not go through the harness browser, another MCP tool, or a helper agent.
- A persona reads a canary or file it should not see (the app source, the plugin, your home folder).
- The Codex runner starts a persona although Codex enabled a feature ux-assessment has not
  classified (it must refuse: it fails closed).
- A saved login state, `.ux-assessment/secrets.local.yaml`, or an API key reaches a persona
  briefing, a report or a log that the docs say is safe to commit.

## Known residual risks

These are known, documented, and not a bypass by themselves:

- **Capabilities without a feature flag** are outside the Codex feature gate. Known ones:
  `apply_patch`, which the read-only sandbox rejects, and **web search**, which cannot reach
  `localhost` but can search the public web about a public app.
- **An ALLOW feature whose meaning changes** in a later Codex build. The self-check
  (`node driver/codex-runner.mjs self-check`) is how that is caught; run it after every Codex update.
- **The Codex read-only sandbox on Windows is unverified.** On Windows and Linux, Codex personas
  rely on tool-level isolation only and are experimental. On macOS, `sandbox-exec` is a second layer.
- **The self-check detects leaks only for the canaries it plants**: a file in the runner folder,
  a file outside it, and a local HTTP port.
- **Windows file modes.** The owner-only modes the driver sets on `.ux-assessment/` do nothing on
  Windows. Keep app projects inside your user profile; the driver warns when a project is outside it.
- **Safety rules on a new tab's first navigation are best effort.** A tab opened by a
  `target="_blank"` link or a `noopener` popup can start loading before the driver controls it (seen
  on Windows and Linux CI). The driver then judges the URL the tab commits: a `stop_before` or
  "leaving the app" match still stops the run and closes the tab, but that request was already sent,
  and a `block` pattern is not enforced. A redirect hop in between is not judged at all, so a chain
  that passes through a `stop_before` URL and ends on an allowed one sends that request with no stop
  and no `max` count. A URL the driver judged earlier in the session is not judged again on this
  path, so one such tab can exceed a `max` limit. `window.open(url)` without `noopener` is not
  affected: the driver loads that URL itself, under the safety rules. Do not rely on `stop_before`
  alone for an action that cannot be undone; point the app at a test backend.

## Supported versions

Only the latest release gets security fixes.
