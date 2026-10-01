# Pack — creative tool (curated)

Planner-only. For apps where people make something: music, drawing, diagrams, video, writing,
design. First curated pack (SPEC D10); dogfooded on the music app (SPEC §10).

## Dimensions (match rule)

Use this pack when the app-profile says **Relationship: creative tool** or **Core loop:
creating**. It fits best with Stakes: low and Access: usable immediately. With signup required,
add the onboarding lens from the charter; with money stakes, it does not fit on its own.

## Lenses

| lens | what to watch |
|---|---|
| Empty canvas | Does a newcomer know what to do first on a blank project? Templates, examples, a hint? |
| First-output time-to-value | Actions until the first thing they made (first sound, first shape). Target: within ~10 actions. |
| Undo / redo | Can a mistake be undone, by button and by Ctrl/Cmd+Z? Is it discoverable? Does it undo the right thing? |
| Flow interruption | Modals, confirmations, sign-up walls or reloads that break the making. |
| Save, export, reopen | Does the person know the work is kept? Can they save, find it again, and reopen it intact? |
| Feedback of invisible output | Sound, rendering, background processing: is there a *visible* sign it works (playhead, meter, progress)? Personas cannot hear. |
| Discoverability of tools | Are the main tools findable without a manual? Icon-only tools, hidden right-click, drag-only actions. |
| Destructive actions | Clear, delete, new project, overwrite: are they guarded or undoable? |

## You might be missing (round 5 checklist)

Recommended ones marked ★.
- ★ A newcomer does not know the work is saved (silent autosave or silent save).
- ★ No visible sign that sound / rendering is happening.
- ★ The first screen is empty, with no example or hint.
- ★ Undo is missing or hidden.
- Jargon of the field (BPM, quantize, layer, blend mode) in the main controls.
- Small screens: the canvas or grid is cut off or too dense to hit.
- Reopening a saved file loses part of the work.
- Deleting or "New" throws away work without asking.

## Persona archetypes (with grounding)

Grounding is `assumption` unless intake gave data.
- **Hobbyist maker** (core) — some domain knowledge, intrinsic motivation, wants to make one small
  thing tonight. Patience 10.
- **Curious non-maker** (casual) — no domain knowledge, saw a friend's creation, low patience 5,
  skims.
- **Professional from another tool** (expert / "not you") — expert in the field, used to a big
  desktop tool's shortcuts and words; judges speed and control. Patience 8.
- **Phone-only beginner** (constrained) — mobile-small, sound off, interrupted, low tech literacy.
  Patience 6.
- **Teacher / parent helping someone** (low tech literacy) — wants to show a child how to make
  something; reads everything, fears breaking things.

## Scenario templates (user language; fill `{output}`: beat, drawing, diagram…)

- "You heard you can make a {output} here in a few minutes. Make one you like."
- "Make a short {output} and keep it so you can show a friend tomorrow."
- "You made a {output} yesterday. Open it again and change one thing." (returning)
- "You changed something and don't like it. Get the earlier version back."
- "Free look: a friend sent you this link. Have a look around."

## Success criteria (checkable)

- The first output exists within N actions (e.g. ≥4 notes placed and playback started within 20).
- The work is saved and reopened intact (harness: `picker-save`, OPFS listing, or a download; the
  reopened state matches).
- An undo restores the previous state (screenshot before and after).
- Playback / render started (harness `audio` signals: `maxPeak > 0`, `nonSilentMs > 0`) *and* the
  persona saw a visible sign of it.
- No destructive action lost work without a warning.

## Typical native surfaces → harness options

| surface | harness option | persona sees |
|---|---|---|
| File System Access save/open (`showSaveFilePicker`, `showOpenFilePicker`) | `fs: shim` | simulated "Save As" / "Open" window |
| `<input type=file>` import (samples, images) | `files: <project>/.ux-assessment/files/` with samples of the accepted types | simulated "Open" window listing those files |
| Microphone / camera (recording) | `permissions: prompt` (fake media devices) | "<site> wants to use your microphone" with Allow / Block |
| MIDI devices (`requestMIDIAccess`) | `permissions: prompt` | the same prompt for MIDI devices |
| `<input type=color>` | always on | simulated color window: swatches and a hex field |
| Downloads (export WAV/PNG) | always on | a note that a download happened; files in `downloads/` |
| Leaving with unsaved work (`beforeunload`) | always on | a note that "Leave site?" was answered "Leave" |
| Cloud save (Google Drive, Dropbox) | `safety` stop-before on the OAuth URL | STOP note; persona ends with `stop_before` |
| Audio output | none — personas cannot hear | only visual feedback; harness logs audio levels |
