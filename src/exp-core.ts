export type ExpAction = "plan" | "award" | "recalibrate";

export interface ExpFactors {
  output: string;
  difficulty: string;
  rigor: string;
  friction: string;
  independence: string;
  significance: string;
}

export interface ExpRecordInput {
  path: string;
  action: ExpAction;
  value: number;
  confidence: number;
  reason: string;
  factors: ExpFactors;
  allowRepeat?: boolean;
}

export interface TaskExpState {
  schema: number;
  value: number;
  state: "planned" | "earned";
  confidence: number;
  reason: string;
  factors: ExpFactors;
  scoredAt: string;
  awardedAt: string | null;
  revision: number;
}

export interface ExpLedgerEntry {
  id: string;
  action: ExpAction;
  taskPath: string;
  taskTitle: string;
  value: number;
  confidence: number;
  reason: string;
  factors: ExpFactors;
  recordedAt: string;
  revision: number;
  citation: string;
  sensitive?: boolean;
}

export interface ExpProgress {
  total: number;
  today: number;
  last7Days: number;
  last30Days: number;
  currentStreak: number;
  longestStreak: number;
  level: number;
  levelProgress: number;
  nextLevelAt: number;
  awards: number;
  recent: ExpLedgerEntry[];
}

export interface ExpCalibrationReview {
  days: number;
  awards: number;
  average: number;
  median: number;
  lowConfidence: number;
  buckets: Array<{ label: string; count: number }>;
  commonScores: Array<{ value: number; count: number }>;
  observations: string[];
  recent: ExpLedgerEntry[];
}

export const expRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export const expString = (value: unknown): string =>
  typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);

export const expNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export const parseExpFactors = (value: unknown): ExpFactors => {
  const row = expRecord(value);
  return {
    output: expString(row.output),
    difficulty: expString(row.difficulty),
    rigor: expString(row.rigor),
    friction: expString(row.friction),
    independence: expString(row.independence),
    significance: expString(row.significance)
  };
};

const localDateKey = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
};

const shiftedDateKey = (date: Date, days: number): string => {
  const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  return localDateKey(shifted);
};

export const validateExpInput = (input: ExpRecordInput): ExpRecordInput => {
  const rawPath = input.path.replace(/\\/g, "/");
  const path = rawPath.replace(/\/+/g, "/").replace(/^\/+/, "");
  if (
    !path
    || rawPath.startsWith("/")
    || /^[a-zA-Z]:\//.test(rawPath)
    || /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(rawPath)
    || path === ".."
    || path.startsWith("../")
    || path.includes("/../")
    || path === ".obsidian"
    || path.startsWith(".obsidian/")
  ) {
    throw new Error("EXP task path must be a safe vault-relative Markdown path.");
  }
  if (!Number.isInteger(input.value) || input.value < 25 || input.value > 1000 || input.value % 25 !== 0) {
    throw new Error("EXP must be 25-1000 and rounded to the nearest 25.");
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error("EXP confidence must be between 0 and 1.");
  }
  if (!input.reason.trim()) throw new Error("EXP scoring requires a short reason.");
  for (const [name, value] of Object.entries(input.factors)) {
    if (!value.trim()) throw new Error(`EXP factor "${name}" requires a short explanation.`);
  }
  return {
    ...input,
    path,
    reason: input.reason.trim(),
    factors: Object.fromEntries(
      Object.entries(input.factors).map(([key, value]) => [key, value.trim()])
    ) as unknown as ExpFactors
  };
};

export const validateExpTransition = (
  action: ExpAction,
  existing: Pick<TaskExpState, "state"> | null,
  allowRepeat = false
): void => {
  if (action === "plan" && existing) {
    throw new Error("This task already has EXP. Use recalibrate for a planned score or award when the work is complete.");
  }
  if (action === "recalibrate" && (!existing || existing.state !== "planned")) {
    throw new Error("Only an existing planned EXP score can be recalibrated.");
  }
  if (action === "award" && existing?.state === "earned" && !allowRepeat) {
    throw new Error("This task already has earned EXP. Use allow_repeat only for a new recurrence or intentional second award.");
  }
};

export const calculateExpStreaks = (
  entries: Pick<ExpLedgerEntry, "action" | "recordedAt">[],
  now = new Date()
): { current: number; longest: number } => {
  const days = [...new Set(entries
    .filter((entry) => entry.action === "award")
    .map((entry) => localDateKey(entry.recordedAt))
    .filter(Boolean))]
    .sort();
  const daySet = new Set(days);
  let cursor = daySet.has(localDateKey(now)) ? 0 : -1;
  let current = 0;
  while (daySet.has(shiftedDateKey(now, cursor))) {
    current += 1;
    cursor -= 1;
  }
  let longest = 0;
  let run = 0;
  let previous: Date | null = null;
  for (const key of days) {
    const [year, month, day] = key.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const consecutive = previous
      ? Math.round((date.getTime() - previous.getTime()) / 86_400_000) === 1
      : false;
    run = consecutive ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }
  return { current, longest };
};

export { localDateKey };
