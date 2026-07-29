export const EXP_SKILL = `---
name: exp
description: Score completed or planned work with experience points based on effort, difficulty, rigor, engagement, and meaningful output. Use for EXP scoring, task valuation, progress reviews, TaskNotes EXP fields, study output, completed work, or replacing time-first tracking with accomplishment-first tracking.
completions:
  - value: status
    description: Show EXP totals, level, and streaks
  - value: history
    description: Browse the EXP ledger
  - value: check
    description: Reconcile completed tasks and process their EXP
  - value: pending
    description: Review pending completion awards
  - value: review
    description: Review scoring consistency
  - value: task
    description: Inspect EXP stored on a task
  - value: calibrate
    description: Start rubric-guided calibration
  - value: score
    description: Score a task or described work
---

# EXP

Evaluate meaningful output while retaining time only as supporting context.

## Workflow

1. Call \`get_task\`, then call \`read_note\` on the task path before scoring. Use the task body, frontmatter, subtasks, and relevant linked context; never score from the title alone unless the note contains no other useful information.
2. Read \`references/rubric.md\` for the scoring factors.
3. Read \`references/examples.md\` when calibration is uncertain or the task resembles an example.
4. Read \`references/schema.md\` before recording or recalibrating EXP.
5. Ask for missing information only when it could materially change the score.
6. Propose one score from 25 to 1000, rounded to the nearest 25.
7. Give a short breakdown for output, difficulty, rigor, friction, independence, and significance, plus confidence from 0 to 1.
8. Use \`record_task_exp\` with action \`plan\` for upcoming work, \`award\` for completed work, or \`recalibrate\` when replacing a planned score.
9. Let the approval preview show the exact change. Never bypass the EXP tool with a generic frontmatter write.
10. Use \`get_exp_progress\` and \`review_exp_calibration\` for progress and consistency reviews.

The EXP service preserves time fields, writes the current score to the task, and adds an immutable Markdown ledger event. Never award the same completion twice. Set \`allow_repeat\` only for a new recurrence or an intentional additional completion.

When this skill is active and Brain creates a task, propose planned EXP immediately after the task is created unless the environment reports that automatic task scoring is enabled. Manual proposals remain separately approved. When automatic task scoring is enabled, newly created non-sensitive TaskNotes are scored by the configured background model and written through the EXP service.
`;

export const EXP_RUBRIC = `# EXP scoring rubric

Score the completed amount, not the person's worth or the time alone.

Start near 100 and adjust for:

- Output volume: how much was concretely completed.
- Cognitive or physical difficulty: how demanding the work was for this user.
- Rigor: depth, accuracy, problem-solving, or quality standards required.
- Friction: confusing language, boredom, uncertainty, or activation difficulty.
- Independence: planning, synthesis, or self-correction performed without heavy guidance.
- Significance: durable progress toward a real goal.

Use these anchors:

- 25-75: tiny maintenance action or very small step.
- 100-200: meaningful ordinary task or focused study unit.
- 225-400: substantial session, difficult assignment, or multi-step output.
- 425-700: major deliverable or unusually demanding accomplishment.
- 725-1000: exceptional milestone; use rarely.

Round to the nearest 25. Avoid inflating repetitive easy volume. Do not penalize a task merely because it was enjoyable. Time can inform effort but never determines the score by itself.
`;

export const EXP_EXAMPLES = `# Calibration examples

## Reading

- Read 15 pages of the Bible: 200 EXP. The language can be colloquial or hard to interpret and may be less engaging, but the activity is not highly academically rigorous.
- Skim 15 familiar pages with little retention: about 75-100 EXP.
- Read and annotate 15 pages of a difficult technical text: about 250-350 EXP.

## Academic work

- Complete a short routine problem set accurately: about 150-225 EXP.
- Solve a difficult unfamiliar problem set and correct mistakes: about 300-450 EXP.
- Produce a polished essay draft requiring synthesis: about 350-550 EXP.

## Life and habits

- Complete a small administrative task: about 50-100 EXP.
- Finish a demanding workout: about 175-300 EXP.
- Complete a major delayed life task with several steps: about 250-450 EXP.

Treat these as calibration points, not fixed lookup values.
`;

export const EXP_SCHEMA = `# EXP storage schema

The task note stores its current EXP state in flat frontmatter:

- \`title: "[EXP] Task title"\` (existing numeric prefixes are replaced)
- \`exp_schema: 2\`
- \`exp: 25..1000\`, rounded to 25
- \`exp_state: planned|earned\`
- \`exp_confidence: 0..1\`
- \`exp_reason: short rationale\`
- \`exp_factors: { output, difficulty, rigor, friction, independence, significance }\`
- \`exp_scored_at: ISO timestamp\`
- \`exp_awarded_at: ISO timestamp or null\`
- \`exp_revision: positive integer\`
- \`exp_task_id: stable task identifier\`
- \`exp_last_completion_id: most recently awarded completion or null\`

Every plan, award, and recalibration also creates an immutable ordinary Markdown
event under \`Brain/EXP/Ledger/YYYY-MM/\` (or the configured Brain folder).
Version 2 award events can include a completion identifier, actual completion
time, scoring source, originating model, token usage, cost, and rubric version.
Totals and streaks count only events whose action is \`award\`. This keeps
recurring-task awards, adjustments, and calibration history reproducible without
a SQL database. Time-tracking fields are never removed or rewritten.
`;

export const EXP_AGENT_METADATA = `interface:
  display_name: "EXP"
  short_description: "Score meaningful work with calibrated EXP"
  default_prompt: "Use $exp to score this task by meaningful output."
`;
