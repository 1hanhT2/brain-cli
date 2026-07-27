# Obsidian Brain

Android-safe Obsidian agent foundation, derived selectively from OpenCode's interaction and permission concepts.

## First foundation

- Obsidian chat `ItemView` with a terminal-inspired interface.
- Real multi-turn OpenRouter chat completions with incremental SSE rendering.
- Stop-generation control backed by request cancellation.
- Native OpenRouter tool calling with iterative tool-result feedback.
- Environment inspection plus Markdown listing, reading, and searching.
- Approval-gated note creation, replacement, and frontmatter updates.
- Markdown-backed chats with new/open/continue/rename/trash session controls.
- Automatic context budgeting with model-generated summaries and safe trimming.
- Searchable OpenRouter catalog with favorites and free/paid filters.
- Model context, pricing, modality, reasoning, structured-output, and tool metadata.
- Secure OpenRouter secret selection through Obsidian `SecretStorage`.
- Synced `Brain/` folders for chats, memory, calibration, settings, and queued work.
- Safe Markdown read/search/create/frontmatter-update primitives.
- Mobile-safe build: no Node filesystem, shell, or desktop-only dependencies at runtime.

## Development

```powershell
npm install
npm run typecheck
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to the target vault plugin directory.

The Obsidian view is the only UI implementation and visual source of truth;
there is no separate browser preview to keep in sync.

## Theme integration

The plugin uses Obsidian's semantic variables for backgrounds, text, borders,
typography, spacing, controls, and motion preferences. Themes and CSS snippets
can optionally customize the Brain surface by overriding these variables on
`.obsidian-brain-view`:

```css
.obsidian-brain-view {
  --brain-background: var(--background-primary);
  --brain-surface: var(--background-secondary);
  --brain-border: var(--background-modifier-border);
  --brain-text: var(--text-normal);
  --brain-muted: var(--text-muted);
  --brain-accent: var(--interactive-accent);
  --brain-assistant-accent: var(--text-accent);
  --brain-error-background: var(--background-modifier-error);
  --brain-radius: var(--radius-s);
  --brain-content-width: 48rem;
}
```
