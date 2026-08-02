# Brain CLI

Android-safe Obsidian agent foundation, derived selectively from OpenCode's interaction and permission concepts.

## First foundation

- Obsidian chat `ItemView` with a command-first terminal interface.
- Slash-command completion, combined `@` skill/file completion, keyboard history, and command-operated chats, models, skills, memory, indexing, and approvals.
- Per-chat read-only plan mode via `Ctrl+Tab`, planning-intent detection, or `/plan`, with write tools removed and rejected while active.
- Real multi-turn OpenRouter chat completions using Obsidian's cross-platform HTTP API and buffered rendering.
- Stop-generation control that reaches model-invoked tools and ignores late network results.
- Native OpenRouter tool calling with iterative tool-result feedback.
- Human-readable tool cards with persistent verified results, inline errors, explicit approval intent, and collapsible technical arguments.
- Environment inspection plus Markdown listing, reading, and searching.
- Native Obsidian Markdown rendering for tables, callouts, wikilinks, code, and math.
- Approval-gated note creation, append, exact patch, replacement, rename, move, trash, and frontmatter updates.
- Before/after diff previews for note mutations.
- Local whole-vault lexical retrieval with clickable source citations.
- Optional mobile-safe Omnisearch integration for ranked lexical retrieval, with the built-in index retained as a fallback.
- Hybrid semantic retrieval using OpenRouter embeddings, exact local cosine search, and reciprocal-rank fusion with Omnisearch or the built-in lexical index.
- Disposable per-device IndexedDB vector storage with deterministic Markdown chunks, curated frontmatter metadata, resumable batch checkpoints, and automatic changed-note updates.
- Scope-safe semantic update queues that ignore unselected folders, reuse unchanged vectors on reload, and report stored versus planned progress live.
- Selected-folder semantic scope, dedicated paged embedding-model browser, configurable spend cap, live CLI indexing progress, and explicit sensitive-content consent.
- Persistent incremental lexical indexing that restores unchanged notes without rereading their Markdown.
- Fast startup paths that skip Brain's built-in lexical scan when Omnisearch is active and reuse compact 24-hour model catalogs from asynchronous IndexedDB storage.
- Lightweight frontmatter chat summaries, semantic-vector hot caching, progressive transcript history, and local `/perf` diagnostics.
- TaskNotes runtime API v1 integration for normalized task queries, inspection, creation, updates, and completion.
- Human-readable intent and result previews for every task query, inspection, EXP operation, mutation, dependency change, and timer action.
- Approval-gated task mutations, post-operation verification, sensitive-task filtering, and a generic Markdown fallback when TaskNotes is unavailable.
- Optional OpenRouter server-side web search alongside Brain's local vault tools.
- Sensitive-tag and credential-pattern detection before note content leaves the vault.
- Traditional `Brain/Skills/<name>/SKILL.md` discovery with progressive reference loading.
- Continual writing-coach sessions with approval-gated timed checks, a randomized balanced five-pillar cycle, and a readable Markdown feedback log.
- Bundled EXP skill with a calibrated 25-1000 accomplishment-first rubric, approval-gated task scoring, and repeat-award protection.
- Flat TaskNotes-compatible EXP frontmatter plus an immutable Markdown event ledger for totals, recurring-task history, streaks, levels, and calibration reviews.
- Event-driven task-completion detection with idempotent recurring awards, `@exp check` reconciliation, and an approval-ready Markdown queue.
- Durable, approval-gated memory fragments with review-only handling, local search, revocation, and ephemeral automatic retrieval for relevant chats.
- EXP analytics by TaskNotes tag/project plus ledger-backed daily, weekly, monthly, and all-time EXP goals.
- Balanced EXP goals with scoped lane minimums, flexible remaining EXP, and lane-aware progress.
- Audited EXP ledger metadata for completion identity, scoring source, model, token usage, cost, and rubric version.
- Versioned portable non-secret configuration under `Brain/Settings/config.md`; secrets, consent grants, and rebuildable caches remain device-local.
- Markdown-backed chats with command-operated new/open/continue/rename/trash session controls.
- Automatic context budgeting with model-generated summaries and safe trimming.
- Command-searchable OpenRouter catalog with favorites and free/paid filters.
- Model context, pricing, modality, reasoning, structured-output, and tool metadata.
- Secure OpenRouter secret selection through Obsidian `SecretStorage`.
- Ordinary local Markdown under `Brain/` for chats, memory, calibration, settings, and queued work. Sync is deliberately outside the plugin.
- Safe Markdown read/search/create/frontmatter-update primitives.
- Mobile-safe build: no Node filesystem, shell, or desktop-only dependencies at runtime.
- Keyboard-only approval and autocomplete flows, screen-reader live regions, visible focus states, and stacked mobile tool previews.

## Installation

### Beta with BRAT

This is the easiest route for personal devices and beta testers while Brain CLI
is awaiting review in Obsidian's community catalog:

1. Install and enable the **BRAT** community plugin in Obsidian.
2. In BRAT, choose **Add Beta plugin**.
3. Enter `1hanhT2/brain-cli` and enable **Brain CLI** when installation finishes.

Repeat this on each desktop or mobile device. BRAT can install future GitHub
releases from the same repository.

### Manual developer installation

Download `main.js`, `manifest.json`, and `styles.css` from a GitHub release and
place them in `<vault>/.obsidian/plugins/brain-cli/`, then reload Obsidian and
enable **Brain CLI**. On mobile, using BRAT is normally simpler than managing
the hidden `.obsidian` directory manually.

Once Brain CLI is accepted into the official Obsidian Community Plugins
catalog, install it from **Settings → Community plugins → Browse** instead.

## Mobile and data disclosure

- Desktop and mobile use the same plugin bundle; `manifest.json` declares
  `isDesktopOnly: false` and runtime code avoids Node, shell, and filesystem APIs.
- An OpenRouter account and API key are required for AI responses. Prompt text,
  note/tool context included by retrieval or explicit approval, and optional
  embedding inputs are sent to OpenRouter and the selected model provider.
- Model calls, embeddings, and optional web search may incur OpenRouter charges.
- Stopping returns control immediately, but Obsidian's `requestUrl` cannot cancel
  a request already accepted by the provider, so that request may still finish
  and be billed.
- The OpenRouter key is selected through Obsidian `SecretStorage`; configure the
  secret on every device where it is unavailable.
- Brain CLI does not add telemetry. Rebuildable indexes remain local, while
  ordinary `Brain/` Markdown can sync through whatever vault-sync method you
  already use.
- TaskNotes and Omnisearch are optional integrations. Their own sync, accounts,
  and privacy behavior remain outside Brain CLI.

## Development

```powershell
npm install
npm test
npm run typecheck
npm run build
# Or run the complete gate:
npm run check
```

Before expanding a beta, complete the [mobile acceptance checklist](docs/MOBILE_ACCEPTANCE.md)
on at least one real phone.

Copy `main.js`, `manifest.json`, and `styles.css` to the target vault plugin directory.

The Obsidian view is the only UI implementation and visual source of truth;
there is no separate browser preview to keep in sync.

## Terminal commands

Type `/` to open the complete command list. Use `Tab` to complete, `↑` and
`↓` to move through the list (it scrolls as needed) or input history, `Enter`
to run, `Shift+Enter` for a newline, `Ctrl+Tab` to switch between default and
read-only plan mode, and `Ctrl+C` to stop generation. Planning phrases such as
“help me plan” and “how should we approach…” automatically enable plan mode;
use `/plan off` to return to default mode.
Type `@` anywhere in a prompt to search installed skills and vault Markdown
files. Use `↑`/`↓` to select and `Enter` or `Tab` to insert; `Escape` closes the
picker. Files are inserted as `@[[full/vault/path.md]]`, so the model can call
the normal approval-aware note tools for their contents. Skills are offered
when `@` begins the prompt. After selecting a skill, typing a space shows every
completion declared by that skill's `SKILL.md` frontmatter.
`@exp` toggles EXP for the current conversation. EXP view requests such as
`@exp history`, `@exp check`, and `@exp pending` run locally; other forms such as `@exp score this task` enable
the skill and send the remaining request. `/skill <name>` remains available
for explicit activation, and `/skill exp history` is an EXP-view alias.
Exact EXP subcommands stay deterministic, while longer natural-language forms
such as `@exp status of my latest task` are sent to the active EXP agent.

```text
/help [page]
/status
/perf [reset]
/new
/plan [on|off|status]
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
/embedding status
/embedding refresh db [--uncapped]
/embedding refresh models
/embedding delete all --confirm
/embedding pause|resume|cancel
/embedding-favorite [number|id]
/skills [page]
/skill <name> [request]
/memory <text>|list|review|search <words>|forget <path> --confirm
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

`@continual-writing-coach` or its short alias `@cwc` starts an ongoing coaching workflow. Give Brain a
writing goal, an `@[[path/to/draft.md]]` file mention, and optionally a fixed
interval or range (10 minutes by default). For example, `every 5–10 minutes`
chooses a new random delay inside that range before each next check. After one explicit approval, Brain checks
only while that draft is the active note and only after its contents change.
The file mention is session-specific rather than a global destination: any
Markdown note can be supplied, and starting the skill with a different file
replaces the previous coaching session after approval.
Each check chooses one pillar from a shuffled cycle—cohesion, grammar, task
achievement, content, or organisation—and returns one brief observation plus
one next action. The configured background OpenRouter model performs the
checks, so they may incur model charges. `@cwc check` requests a nudge now,
`@cwc status` shows the session, and `@cwc stop` ends it. The corresponding
explicit forms are `/skill cwc check`, `/skill cwc status`, and `/skill cwc
stop`. All coach controls remain within the skill invocation. Session state and
feedback remain readable under `Brain/Coaching/writing-session.md`; sensitive
or excluded notes cannot be enrolled in automatic coaching.
When a draft contains only a heading, fragment, or opening sentence, the coach
prioritizes momentum: it tells the writer to continue and offers one small
pillar-relevant hint instead of critiquing unfinished structure.

Tool-capable models can query, inspect, create, update, and complete tasks;
manage blocking dependencies; and start or stop TaskNotes time tracking.
Brain prefers TaskNotes's mobile-safe
in-process runtime API and uses its configured status and recurrence behavior.
If TaskNotes API v1 is unavailable, the same stable tool contract operates on
ordinary frontmatter tasks in the configured fallback task folder.

Calendar scheduling is task-backed. Brain searches active tasks first, updates
one clear match or creates a new TaskNotes task, and stores date-only schedules
as all-day values or local datetimes plus `timeEstimate` for timed blocks.
TaskNotes remains the sole owner of its Google OAuth connection and performs
calendar export in the background. Brain does not inspect external conflicts,
edit unrelated Google events, or claim that a successful TaskNotes mutation
verifies the external event. Markdown fallback remains available for ordinary
task capture but is never represented as Google Calendar scheduling.

`/skill exp` or `@exp <request>` activates the accomplishment-first scoring
workflow. The model reads the complete task note and relevant context, applies
the six-factor rubric, and uses `record_task_exp` to
show a readable approval preview. Approved changes store the current score in
flat task frontmatter and add an immutable event under
`Brain/EXP/Ledger/YYYY-MM/`. `plan`, `award`, and `recalibrate` events remain
auditable; only awards count toward totals and streaks. `@exp status` shows
progress, `@exp cutoff today` ignores completions before the current date for both automatic detection and reconciliation, `@exp history` pages through the ledger, `@exp review` checks score
distribution and confidence, `@exp task` inspects one task, and
`@exp calibrate` starts a rubric-guided scoring session. `@exp analytics [days]`
breaks earned EXP down by task tag and project; `@exp goals` shows active goals.

Completion detection is opt-in. Brain debounces TaskNotes and Markdown metadata
changes, establishes a baseline before first enabling the watcher, and records
each non-recurring completion once or each unique recurring
`complete_instances` occurrence once. `@exp check` reconciles changes missed
while Brain was closed. Existing planned EXP is reused without another model
call; unscored completions either use the background model or remain
`needs-score`, according to `/config`.

`@exp pending` contains completed-task award proposals only. `@exp unscored`
lists accessible tasks with neither planned nor earned EXP, and `@exp sync`
requeues open unscored tasks while reconciling completed-task awards. Automatic
planned-score failures are retained locally with their last error until a sync
retries them or the task is resolved.

Open tasks receive planned EXP so their expected reward is visible before work
begins. Completion promotes that planned value to earned EXP. When automatic
task scoring is enabled, startup also reconciles open tasks that missed their
creation event, preventing them from remaining indefinitely unscored.

`@exp score-completed` turns every `needs-score` completion proposal into one
explicit scoring session. Brain reads each task before scoring it and still
pauses on a separate approval preview for each award, so a batch never creates
unreviewed EXP writes.

When automatic award writes are disabled, `@exp pending` opens a CLI checklist.
Use arrows to navigate, Space to select ready proposals, and Enter to show one
batch approval preview. `/approve` records the selected awards; `/deny` leaves
their readable queue notes under `Brain/Queue/EXP/Pending/`. Focusing a
`needs-score` row inserts an `@exp score` request for that task.

Brain stores scored TaskNotes as `[200] Task title`; an existing prefix is
replaced, and titles longer than the configured limit are shortened at a word
boundary. With EXP active, a task created through Brain gets a planned-score
proposal as a separate approval unless automatic scoring is enabled. The
opt-in automatic queue sends newly created non-sensitive TaskNotes to the
background OpenRouter model and writes planned EXP without another approval.
The queue is task-scoped, waits for note metadata to settle, survives reloads,
retries transient or malformed responses up to three times, and stops at the
configurable per-session spend cap (default `$0.10`). `/status` shows its
queue, activity, and estimated spend. Cancelling or disabling it aborts the
active request before the EXP transaction can commit.
The command-palette action **Run @exp on active TaskNote** performs the same
workflow on demand. Existing time fields are left intact.
Task queries also accept a `completed_on` date, including recurring
`complete_instances`, so the agent can reliably find and score the outputs
completed on a particular daily note.

Portable preferences are stored in `Brain/Settings/config.md`, including model
choices, favorites, retrieval scopes, spend caps, exclusions, and completion
detection. The OpenRouter secret, explicit consent for automatic writes or
sensitive disclosure, local completion baseline, and database identifiers stay
in plugin data. Embeddings, lexical indexes, and model catalogs remain
rebuildable IndexedDB caches. Each AI-generated EXP ledger event records its
model and available usage/cost metadata without saving the model prompt or full
task contents.

Memory fragments are ordinary Markdown in `Brain/Memory/`. `/memory <text>`
creates a low-risk fragment; `/memory list`, `/memory review`, and
`/memory search <words>` provide local review. The model may propose a concise
memory through an approval preview when the user explicitly confirms something
durable. Fragments marked `review` are never automatically injected; active
low-risk memories are retrieved only for a relevant chat request and are not
saved into the chat transcript. `/memory forget <path> --confirm` revokes a
fragment without destroying its audit trail.

EXP goals are Markdown under `Brain/EXP/Goals/`, created through the
approval-gated `create_exp_goal` tool. New EXP ledger events snapshot the
TaskNote tags and projects at award time, so later task edits do not rewrite
historical analytics.

`/config`, `/setting`, and `/settings` open the terminal settings menu. Use
the arrow keys to select an item, `Space` to toggle its checkbox, and `Enter`
to leave. `/settings native` opens Obsidian's regular plugin settings tab.
When Omnisearch is enabled and available, Brain uses its public in-process API
for lexical `search_notes` and `retrieve_context` calls. Brain rechecks every
result against its own exclusions and sensitive-content policy and skips its
complete-vault lexical scan at startup. If Omnisearch is disabled, unavailable,
or errors, the persistent built-in index loads cached notes and rereads only
new or changed Markdown.
Bundled skills are installed only when their bundle version changes, and
vault-triggered skill rescans are debounced. Catalog, lexical, EXP, and
semantic initialization are scheduled in separate post-layout phases to reduce
plugin `onload` work and startup contention.
Changing excluded paths or sensitive tags immediately cancels active indexing,
purges stale eligibility, and rebuilds both lexical and enabled semantic
coverage. Task privacy checks inspect the actual Markdown body and frontmatter,
including scalar tags, `sensitive: true`, privacy labels, and credential
patterns. Approved sensitive tool results and derived assistant text are
ephemeral and are redacted from saved chat state after that turn.
The neighboring OpenRouter web-search checkbox adds
`openrouter:web_search` to chat requests. The model can then search current
internet sources while retaining access to Brain's local tools; web search is
off by default and may incur OpenRouter search charges when used. Because
OpenRouter's server-tool path is still beta, a 5xx response automatically
retries once using OpenRouter's deprecated but model-agnostic `web` plugin.

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
Embedding maintenance lives under `/embedding`: `refresh db` reconciles the
selected folders while reusing unchanged vectors, and `delete all --confirm`
clears only the local IndexedDB vector cache without touching Markdown notes.

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
`.brain-cli-view`:

```css
.brain-cli-view {
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
