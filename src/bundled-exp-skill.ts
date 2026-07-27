export const EXP_SKILL = `---
name: exp
description: Score completed or planned work with experience points based on effort, difficulty, rigor, engagement, and meaningful output. Use for EXP scoring, task valuation, progress reviews, TaskNotes EXP fields, study output, completed work, or replacing time-first tracking with accomplishment-first tracking.
---

# EXP

Evaluate meaningful output while retaining time only as supporting context.

## Workflow

1. Inspect the task note and relevant context before scoring.
2. Read \`references/rubric.md\` for the scoring factors.
3. Read \`references/examples.md\` when calibration is uncertain or the task resembles an example.
4. Ask for missing information only when it could materially change the score.
5. Propose one score from 25 to 1000, rounded to the nearest 25.
6. Give a short factor breakdown and confidence.
7. Update task frontmatter only after the user approves the write.
8. Preserve any existing time fields; EXP is the primary progress measure, not a replacement for recorded time.

Use the general note and frontmatter tools. Do not assume TaskNotes field names without inspecting the note.
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

export const EXP_AGENT_METADATA = `interface:
  display_name: "EXP"
  short_description: "Score meaningful work with calibrated EXP"
  default_prompt: "Use $exp to score this task by meaningful output."
`;
