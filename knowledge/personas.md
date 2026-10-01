# Personas — coverage rules, card schema, briefing

Plain knowledge, harness-independent (SPEC D2, §5). The planner reads this; personas never do.

## Coverage rules (default set, 5–7 personas)

1. **Core user** — matches the developer's description. Always included.
2. **"Not you"** — as different from the developer as possible, especially if the developer is the
   target user. Leaving it out means the app is only tested by people who think like its builder.
3. **Casual / low motivation** — low patience budget; measures whether the app pulls people in.
   Leaving it out hides first-impression problems, because motivated personas push through them.
4. **Low tech literacy.**
5. **Constrained** — small screen / slow network / accessibility, chosen by the app's risk.
6. **Expert / power user** — only when the app is used repeatedly.

**Guided / Expert / unattended: 5–7 personas** by these rules. **Quick mode: core + casual +
constrained** (3 personas).

Start from the pack's persona archetypes (`knowledge/packs/<pack>.md`, or the project's ad-hoc
pack in `.ux-assessment/packs/`, see `knowledge/charter.md` → "Choosing a pack") and adapt them
to the intake answers. An ad-hoc pack's archetypes are unreviewed: their grounding is
`assumption`.

## Customise (two multi-select questions, ≤4 options each; SPEC D11)

- "Who will use it?": Not you · Casual user · Low tech literacy · Expert.
- "Under what conditions?": Small phone screen · Slow network · Screen reader · Low vision.

Mark the recommended ones "(recommended)" (pre-ticking is not supported). The descriptions of
"Not you" and "Casual" state what leaving them out costs (see rules 2 and 3). Free text ("Other")
can describe extra people; turn it into cards. The core user always stays. Screen reader needs
the a11y-tree perception, which the driver does not have yet: say so and leave it out.

Contrast check: if two cards differ only in label or one trait, merge them. Every card states its
`grounding`: `data` (real users / analytics), `quiz` (the developer's answers) or `assumption`.

Never make a persona "low skill" by using a weaker model; low skill comes from traits (SPEC D18).

## Card schema

```yaml
id: casual-curious                 # kebab-case; also the session id and the run folder name
label: "Curious visitor, low commitment"
grounding: assumption              # data | quiz | assumption
goal: "Saw a friend's post, wants to see what this is"   # user language, never UI names
motivation: casual                 # intrinsic | curious | forced | casual
domain_knowledge: none             # none | some | expert
tech_literacy: medium              # low | medium | high
native_language: th
ui_language_proficiency: {en: low, th: native}
patience_budget: 6                 # frustration points before quitting (casual 4–6, core 8–12)
reading_style: skim                # read-all | skim | icons-only
perception: screenshot             # screenshot | a11y-tree (a11y-tree: not in the driver yet)
device: {viewport: desktop, network: normal}   # viewport: desktop | mobile-small
context: "On the bus, sound off, interrupted often"
mental_model: "Has used simple phone music apps"
entry_point: "Tapped a link in a LINE group, no explanation"
start_state: newcomer              # newcomer | returning
account: main                      # returning only: an account id in secrets.local.yaml
quit_triggers: ["asked to sign up before seeing anything", "nothing happens after tapping"]
```

Step cap per session: the config `cap`, 30 by default (two thirds of it for casual personas: they do not stay long anyway).

## Start states and test accounts (SPEC D6)

- **newcomer** — no account. If the scenario needs a signup, the persona uses a tagged email
  `ux-sim+<persona id>@example.com` (SPEC D5). Signup that needs a real email or SMS code cannot
  be completed: the scenario stops there, and it goes under "Not tested".
- **returning** — logged in from the start through a saved state. Credentials live in
  `.ux-assessment/secrets.local.yaml` (gitignored; the developer fills it in, never the planner):

```yaml
accounts:
  - id: main                       # referenced by the card's `account`
    kind: password                 # password | oauth | otp  (oauth/otp: manual login once)
    login_url: http://localhost:3000/login
    email: ux-sim+main@example.com
    password: "…"
```

  The orchestrator logs in once per account in a setup session and saves the state to
  `.ux-assessment/state/<account>.json` (SKILL step 5). Several returning personas on one account
  share server-side state: run them one after another.

## Briefing — the only thing a persona receives (knowledge isolation, SPEC §3)

Build it from this template and nothing else. It is the persona agent's whole world.
"What you want" is the scenario — the task this run tests, including every part the success
criterion needs — never the card's `goal` alone: that is only why the persona came, and a persona
briefed with it declares success too early (timer-app run 5, 2026-09-28: 5/6 at the Start screen).

```
Session id: <id>

Who you are:
<persona card YAML without `grounding`>

How you got here: <entry_point, in user language>
What you want: <this persona's scenario from the run's plan (plans/<date>.md), in full, in user language>
<if returning>You already have an account: email <x>, password <y>. You do not remember what is in it.</if>
<if newcomer and signup is needed>If you sign up, your email is ux-sim+<id>@example.com; choose your own password.</if>
Stop before: <stop-before rules in user language, the same words as the charter's `stop_before` labels, e.g. "paying", "connecting your Google account">
You have at most <cap> actions, and you give up when your frustration reaches <patience_budget>.

The app is already open in front of you. Start with a look.
```

A briefing must **never** contain: code, file names, routes or URLs other than the entry URL the
persona "clicked", component or button names the persona has not seen, the app-profile, the
charter, other personas' results, or hints about where things are. The returning line gives
only the login facts: never what the account contains, which page to start from, or that a saved
state exists. Scenario text says what the
person wants ("make a short beat and keep it"), never how ("press the Save button").
