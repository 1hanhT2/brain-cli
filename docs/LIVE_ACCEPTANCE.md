# Live acceptance report

Date: 2026-07-27  
Obsidian: 1.12.7 on Windows  
Provider route: `openrouter/free`

## Results

| Case | Result | Evidence |
| --- | --- | --- |
| Plugin startup and reload | Pass | Plugin reloaded with existing `Brain` folders and opened the Brain view without an error notice. |
| Real OpenRouter streaming | Pass | Multiple live turns streamed and completed through the configured Obsidian secret. |
| Native Markdown | Pass | An unfenced Markdown table and Obsidian info callout rendered through Obsidian's native renderer. |
| Environment tool | Pass | `get_environment` returned the live vault, 295 Markdown files, retrieval status, installed EXP skill, capabilities, exclusions, and safety limits. |
| Write approval | Pass | `create_note` paused before writing, showed its proposed content, and created the note only after approval. |
| Exact patch preview and denial | Pass | `apply_note_patch` showed one red/green before-and-after occurrence; denial left the note unchanged. |
| Frontmatter write | Pass | `update_frontmatter` required approval and wrote `sensitive: true` after approval. |
| Sensitive read approval | Pass | `read_note` detected sensitive frontmatter and did not expose content after denial. |
| Recoverable deletion | Pass | `trash_note` required approval and moved the disposable note to `.trash/Brain Acceptance Test.md`. |
| Citations | Pass | `read_note` returned `[[Home]]`; the final rendered response preserved it as a clickable Obsidian link. |
| Chat persistence and reopening | Pass | Saved chats reopened with rendered Markdown, previous tool cards, final responses, and citations intact. |
| Traditional EXP skill | Pass | EXP was discovered from `Brain/Skills/exp/SKILL.md` and auto-activated when the live prompt referred to EXP. |

## Bugs found and fixed

- Startup was not idempotent while Obsidian's Vault index lagged behind folders already present on disk. Brain layout, bundled-skill layout, and tool-created folder paths now check the adapter and tolerate concurrent folder creation.
- Older saved chats retained an outdated base system prompt. Reopening a chat now refreshes the versioned base prompt while preserving conversation and active-skill messages.
- Skill status terminology was ambiguous. Environment output now reports `installedSkills`, and the system contract distinguishes installed/discovered skills from conversation activation.

## Provider observation

During one long mixed approval conversation, the free model route retried a previously denied patch after completing a different frontmatter write. The approval gate stopped the retry and the note remained unchanged. Fresh-chat sensitive and citation cases then passed. This is contained safely, but turn-level provider reliability and retry controls remain future hardening work.
