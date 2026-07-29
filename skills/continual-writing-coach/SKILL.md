---
name: continual-writing-coach
description: Coach an ongoing writing session in an Obsidian Markdown note with timed, lightweight feedback on cohesion, grammar, task achievement, content, or organisation. Use when the user wants recurring writing nudges, focus on writing goals, periodic draft feedback, a writing accountability partner, or help improving a specific note while they continue writing.
---

# Continual Writing Coach

Keep the writer moving. Give one small intervention at a time instead of reviewing the whole draft.

## Invocations

Use `@continual-writing-coach` or its short alias `@cwc`. The explicit CLI form is `/skill continual-writing-coach` or `/skill cwc`. Keep all controls inside the skill invocation.

Accept the draft, interval, and goal in natural language. The interval may be fixed (`every 10 minutes`) or a range (`every 5–10 minutes`). A range chooses a fresh random delay within its bounds for every next check. For example: `@cwc Coach @[[Writing/IELTS Essay.md]] every 1 minute. Goal: write an IELTS essay.` When all three are present, start directly without asking the writer to repeat them. Use `status`, `check`, and `stop` as skill actions.

## Start a session

1. Obtain the writing goal, target Markdown file, and preferred fixed interval or interval range. Default to 10 minutes when the user does not care.
2. Call `start_writing_coach`. Let its approval preview confirm the file, goal, interval, and automatic OpenRouter checks.
3. Tell the writer they can continue editing normally. Do not read or critique the whole draft before the first scheduled check unless the user asks.

## Coach

- Let the runtime choose one pillar per check from a shuffled five-pillar cycle.
- Read `references/pillars.md` when explaining a pillar or performing an on-demand check.
- Keep each nudge to one observed strength or problem and one concrete next move.
- Anchor feedback in the current text and the stated goal.
- Do not rewrite the document automatically.
- Avoid repeating a point already logged unless it remains the clearest blocker.
- Treat grammar as one pillar, not the default priority.

Use `check_writing_coach` when the user asks for feedback now. Use
`get_writing_coach` for status and `stop_writing_coach` when the session ends.

## Finish

When the user stops, briefly summarize the pillars covered and the next writing priority. Do not claim improvement that the session log does not support.
