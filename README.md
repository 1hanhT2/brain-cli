# Obsidian Brain

Android-safe Obsidian agent foundation, derived selectively from OpenCode's interaction and permission concepts.

## First foundation

- Obsidian chat `ItemView` with a command-first terminal interface.
- Slash-command completion, keyboard history, and command-operated chats, models, skills, memory, indexing, and approvals.
- Real multi-turn OpenRouter chat completions with incremental SSE rendering.
- Stop-generation control backed by request cancellation.
- Native OpenRouter tool calling with iterative tool-result feedback.
- Environment inspection plus Markdown listing, reading, and searching.
- Native Obsidian Markdown rendering for tables, callouts, wikilinks, code, and math.
- Approval-gated note creation, append, exact patch, replacement, rename, move, trash, and frontmatter updates.
- Before/after diff previews for note mutations.
- Local whole-vault lexical retrieval with clickable source citations.
- Optional mobile-safe Omnisearch integration for ranked lexical retrieval, with the built-in index retained as a fallback.
- Optional OpenRouter server-side web search alongside Brain's local vault tools.
- Sensitive-tag and credential-pattern detection before note content leaves the vault.
- Traditional `Brain/Skills/<name>/SKILL.md` discovery with progressive reference loading.
- Bundled EXP skill with a calibrated 25-1000 accomplishment-first rubric.
- Markdown-backed chats with command-operated new/open/continue/rename/trash session controls.
- Automatic context budgeting with model-generated summaries and safe trimming.
- Command-searchable OpenRouter catalog with favorites and free/paid filters.
- Model context, pricing, modality, reasoning, structured-output, and tool metadata.
- Secure OpenRouter secret selection through Obsidian `SecretStorage`.
- Ordinary local Markdown under `Brain/` for chats, memory, calibration, settings, and queued work. Sync is deliberately outside the plugin.
- Safe Markdown read/search/create/frontmatter-update primitives.
- Mobile-safe build: no Node filesystem, shell, or desktop-only dependencies at runtime.

## Development

```powershell
npm install
npm test
npm run typecheck
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to the target vault plugin directory.

The Obsidian view is the only UI implementation and visual source of truth;
there is no separate browser preview to keep in sync.

## Terminal commands

Type `/` to open completion. Use `Tab` to complete, arrow keys to navigate
suggestions or input history, `Enter` to run, `Shift+Enter` for a newline, and
`Ctrl+C` to stop generation.

```text
/help
/status
/new
/chats [query]
/open <number|title>
/rename <title>
/delete --confirm
/models [all|free|paid|favorites] [query]
/model <number|id>
/favorite [number|id]
/refresh
/skills
/skill <name>
/memory <text>
/index rebuild
/config
/setting
/settings [native]
/clear
/approve
/deny
/stop
```

Plain text still starts or continues a model conversation. Read tools execute
automatically. Write and sensitive-read previews pause the agent and accept
`/approve` or `/deny` directly from the terminal prompt.

`/config`, `/setting`, and `/settings` open the terminal settings menu. Use
the arrow keys to select an item, `Space` to toggle its checkbox, and `Enter`
to leave. `/settings native` opens Obsidian's regular plugin settings tab.
When Omnisearch is enabled and available, Brain uses its public in-process API
for lexical `search_notes` and `retrieve_context` calls. Brain rechecks every
result against its own exclusions and sensitive-content policy. If Omnisearch
is disabled, unavailable, or errors, the built-in local index remains active.
The neighboring OpenRouter web-search checkbox adds
`openrouter:web_search` to chat requests. The model can then search current
internet sources while retaining access to Brain's local tools; web search is
off by default and may incur OpenRouter search charges when used.

## Theme integration

The plugin uses Obsidian's semantic variables for backgrounds, text, borders,
typography, spacing, controls, and motion preferences. Themes and CSS snippets
can optionally customize the Brain surface by overriding these variables on
`.obsidian-brain-view`:

```css
.obsidian-brain-view {
  --brain-bg: var(--background-primary);
  --brain-surface: var(--background-secondary);
  --brain-border: var(--background-modifier-border);
  --brain-text: var(--text-normal);
  --brain-muted: var(--text-muted);
  --brain-accent: var(--text-accent);
  --brain-success: var(--text-success);
  --brain-warning: var(--text-warning);
  --brain-error: var(--text-error);
  --brain-radius: var(--radius-s);
  --brain-content-width: 58rem;
}
```
