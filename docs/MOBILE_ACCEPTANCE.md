# Mobile acceptance checklist

Run this checklist on every mobile platform claimed for a public release. Record
the device, OS, Obsidian version, Brain CLI version, and result for each case.

## Installation and lifecycle

- [ ] Install the GitHub release through BRAT and confirm the displayed version.
- [ ] Enable Brain CLI, open its view, close Obsidian, and reopen it without a startup error.
- [ ] Background/resume does not duplicate queued EXP work or lose the active chat.

## OpenRouter and cancellation

- [ ] Select an OpenRouter secret on the device and complete one normal response.
- [ ] Start a long response and stop it from the button and from Ctrl+C with a hardware keyboard.
- [ ] Run semantic `/search`, stop it, and confirm the terminal returns to a usable state promptly.
- [ ] Confirm the user-facing disclosure that an already accepted provider request may still be billed.

## Vault safety and privacy

- [ ] Deny a note-write preview and confirm the note remains unchanged.
- [ ] Approve a note append, then confirm deletion follows the device's configured trash preference.
- [ ] Mark a note `sensitivity: review`; generic search and retrieval must not return it.
- [ ] Memory review can show that fragment locally, while automatic memory retrieval cannot.
- [ ] Edit a note after a whole-note replacement preview; approval must reject the stale replacement.

## Optional integrations

- [ ] If installed, TaskNotes queries and one approval-gated mutation work through runtime API v1.
- [ ] If installed, Omnisearch results remain filtered by Brain exclusions and sensitivity rules.
- [ ] If semantic search is enabled, the selected scope, spend cap, pause, resume, and cancel controls work.

## Evidence

Save a short report under `docs/` containing the checklist results and any
screenshots or reproducible failures. Do not include API keys or private note text.
