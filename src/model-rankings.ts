export interface DailyModelRanking {
  date: string;
  model_permaslug: string;
  total_tokens: string;
}

export interface ModelUsageRanking {
  modelId: string;
  totalTokens: bigint;
  previousTokens: bigint;
  growthTokens: bigint;
}

const tokenCount = (value: string): bigint => {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

const aggregate = (
  rows: DailyModelRanking[],
  allowedDates?: Set<string>
): Map<string, bigint> => {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    if (!row.model_permaslug || row.model_permaslug === "other") continue;
    if (allowedDates && !allowedDates.has(row.date)) continue;
    totals.set(
      row.model_permaslug,
      (totals.get(row.model_permaslug) ?? 0n) + tokenCount(row.total_tokens)
    );
  }
  return totals;
};

export const rankPopularModels = (rows: DailyModelRanking[]): ModelUsageRanking[] =>
  [...aggregate(rows).entries()]
    .map(([modelId, totalTokens]) => ({
      modelId,
      totalTokens,
      previousTokens: 0n,
      growthTokens: 0n
    }))
    .sort((left, right) =>
      left.totalTokens === right.totalTokens ? left.modelId.localeCompare(right.modelId)
        : left.totalTokens > right.totalTokens ? -1 : 1
    );

export const rankTrendingModels = (
  rows: DailyModelRanking[],
  windowDays = 7
): ModelUsageRanking[] => {
  const dates = [...new Set(rows.map((row) => row.date).filter(Boolean))]
    .sort((left, right) => right.localeCompare(left));
  const recentDates = new Set(dates.slice(0, windowDays));
  const previousDates = new Set(dates.slice(windowDays, windowDays * 2));
  const recent = aggregate(rows, recentDates);
  const previous = aggregate(rows, previousDates);
  const modelIds = new Set([...recent.keys(), ...previous.keys()]);
  return [...modelIds].map((modelId) => {
    const totalTokens = recent.get(modelId) ?? 0n;
    const previousTokens = previous.get(modelId) ?? 0n;
    return {
      modelId,
      totalTokens,
      previousTokens,
      growthTokens: totalTokens - previousTokens
    };
  }).filter((ranking) => ranking.growthTokens > 0n)
    .sort((left, right) =>
      left.growthTokens === right.growthTokens ? left.modelId.localeCompare(right.modelId)
        : left.growthTokens > right.growthTokens ? -1 : 1
    );
};

export const rankingDateRange = (
  days: number,
  end = new Date()
): { startDate: string; endDate: string } => {
  const safeDays = Math.max(1, Math.floor(days));
  const endUtc = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  endUtc.setUTCDate(endUtc.getUTCDate() - 1);
  const startUtc = new Date(endUtc);
  startUtc.setUTCDate(startUtc.getUTCDate() - safeDays + 1);
  return {
    startDate: startUtc.toISOString().slice(0, 10),
    endDate: endUtc.toISOString().slice(0, 10)
  };
};
