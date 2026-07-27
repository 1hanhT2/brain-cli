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
- Hybrid semantic retrieval using OpenRouter embeddings, exact local cosine search, and reciprocal-rank fusion with Omnisearch or the built-in lexical index.
- Disposable per-device IndexedDB vector storage with deterministic Markdown chunks, curated frontmatter metadata, resumable batch checkpoints, and automatic changed-note updates.
- Selected-folder semantic scope, dedicated paged embedding-model browser, configurable spend cap, live CLI indexing progress, and explicit sensitive-content consent.
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
/help [page]
/status
/new
/chats [page] [query]
/open <number|title>
/rename <title>
/delete --confirm
/models [all|popular|trending|free|paid|favorites] [7d|30d] [page] [query]
/model <number|id>
/favorite [number|id]
/refresh
/embeddings [all|favorites] [page] [query]
/embedding <number|id> [--confirm]
/embedding-favorite [number|id]
/skills [page]
/skill <name>
/memory <text>
/search <query> [--mode hybrid|semantic|lexical] [--folder path] [--tag tag] [--property key=value] [--limit n]
/index status
/index rebuild
/index rebuild semantic [--uncapped]
/index pause
/index resume [--uncapped]
/index cancel
/index clear semantic --confirm
/semantic folders
/semantic cap <usd|unlimited>
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

Semantic search is also off by default. Enabling it requires an explicit
OpenRouter embedding model and at least one folder selected through the
Space-to-toggle terminal picker. The local vector index is a rebuildable
IndexedDB cache and is never synced. Indexing resumes automatically after an
interruption, updates changed chunks, and pauses before exceeding the default
per-job `$0.25` estimate. `/search` shows ranked excerpts without another chat
model call; `retrieve_context` exposes the same hybrid engine to tool-capable
models. Disabling sensitive semantic access immediately purges sensitive
vectors. Enabling it requires two confirmations because both embedding and
automatic retrieval may disclose those excerpts to OpenRouter models.

List commands use 30-row pages instead of truncating results. For example,
`/models all 2`, `/models popular 30d 1`, `/models trending 7d 2`,
`/embeddings all 2`, `/chats 2`, and `/skills 2`. Numbers passed to
`/model`, `/favorite`, `/embedding`, `/embedding-favorite`, and
`/open` refer to the most recently displayed page. Popularity aggregates
OpenRouter's daily token-usage rankings; trending compares the newest ranking
window with the preceding window. The singular form also accepts an explicit
model filter, so `/model all 1` and `/model popular 1` open those lists while
`/model 1` still selects row 1 from the current page.

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
