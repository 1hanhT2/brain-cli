const positiveInteger = (value: string | undefined): boolean =>
  value !== undefined && /^\d+$/.test(value) && Number.parseInt(value, 10) > 0;

export const isLocalExpCommand = (parts: string[]): boolean => {
  const action = parts[0]?.toLocaleLowerCase();
  if (!action) return false;
  if (["status", "check", "pending", "score-completed", "goals", "calibrate", "sync"].includes(action)) {
    return parts.length === 1;
  }
  if (action === "cutoff") return parts.length <= 2;
  if (["analytics", "review", "history", "unscored"].includes(action)) {
    return parts.length === 1 || (parts.length === 2 && positiveInteger(parts[1]));
  }
  if (action === "task") return parts.length >= 2;
  return false;
};
