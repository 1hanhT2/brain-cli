export type InteractionMode = "default" | "plan";

const PLANNING_PATTERNS = [
  /\b(?:help\s+(?:me|us)\s+|let(?:'s| us)\s+)?plan(?:ning)?\b/i,
  /\b(?:make|create|draft|write|give\s+(?:me|us)|come\s+up\s+with)\s+(?:me\s+|us\s+)?(?:an?\s+)?(?:detailed\s+|implementation\s+|project\s+|step-by-step\s+)?plan\b/i,
  /\b(?:design|outline|map\s+out)\s+(?:a\s+|an\s+|the\s+)?(?:solution|approach|implementation|steps|architecture|workflow)\b/i,
  /\bhow\s+(?:should|could|would)\s+(?:i|we|you)\s+(?:approach|build|change|design|implement|migrate|refactor|solve)\b/i,
  /\bbefore\s+(?:i|we|you)\s+(?:build|change|edit|implement|migrate|refactor|write)\b/i
];

export const detectsPlanningIntent = (text: string): boolean => {
  const normalized = text.replace(/@\[\[[^\]]+\]\]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || /\b(?:execute|implement|follow|use)\s+(?:this|the|our|that)\s+plan\b/i.test(normalized)) {
    return false;
  }
  return PLANNING_PATTERNS.some((pattern) => pattern.test(normalized));
};

export const planModeSystemMessage = (): string => [
  "[Brain CLI interaction mode: plan]",
  "Explore and reason with read-only tools, then produce a decision-complete plan.",
  "Do not create, edit, rename, delete, complete, or otherwise mutate notes, tasks, memory, settings, or external state.",
  "Ask concise clarifying questions only when a missing decision materially changes the plan; otherwise state reasonable assumptions.",
  "Do not claim implementation occurred. Clearly distinguish inspected facts from proposed work."
].join("\n");
