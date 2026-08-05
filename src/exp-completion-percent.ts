export const EXP_COMPLETION_PERCENTS = [25, 50, 75, 100] as const;
export type ExpCompletionPercent = typeof EXP_COMPLETION_PERCENTS[number];

export const isExpCompletionPercent = (value: unknown): value is ExpCompletionPercent =>
  typeof value === "number" && EXP_COMPLETION_PERCENTS.includes(value as ExpCompletionPercent);

export const completionPercentFromTitle = (title: string): ExpCompletionPercent | null => {
  const match = title.match(/(?:^|\s)\[(25|50|75|100)%\](?:\s|$)/);
  return match ? Number(match[1]) as ExpCompletionPercent : null;
};

export const stripCompletionPercentMarker = (title: string): string =>
  title.replace(/(?:^|\s)\[(?:25|50|75|100)%\](?=\s|$)/g, " ").replace(/\s+/g, " ").trim();

export const scaledExpForCompletion = (plannedExp: number, percent: ExpCompletionPercent): number =>
  Math.max(25, Math.round((plannedExp * percent) / 2_500) * 25);
