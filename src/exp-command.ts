const positiveInteger = (value: string | undefined): boolean =>
  value !== undefined && /^\d+$/.test(value) && Number.parseInt(value, 10) > 0;

const EXP_SKILL_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export const removeLegacyExpSyncCommand = (content: string): string => {
  const frontmatter = content.match(EXP_SKILL_FRONTMATTER_PATTERN)?.[0] ?? "";
  let migrated = content;
  if (frontmatter) {
    let updated = frontmatter.replace(
      /\r?\n  - value: sync\r?\n    description: [^\r\n]*/g,
      ""
    );
    if (!updated.includes("value: reconcile")) {
      updated = updated.replace(
        /\r?\n---\r?\n?$/,
        "\n  - value: reconcile\n    description: Reconcile unscored tasks and completed-task EXP\n---\n"
      );
    }
    migrated = `${updated}${migrated.slice(frontmatter.length)}`;
  }
  return migrated.replace(/@exp sync\b/g, "@exp reconcile");
};

export const isLocalExpCommand = (parts: string[]): boolean => {
  const action = parts[0]?.toLocaleLowerCase();
  if (!action) return false;
  if (["status", "check", "pending", "score-completed", "goals", "calibrate", "reconcile"].includes(action)) {
    return parts.length === 1;
  }
  if (action === "reset") return parts.length === 1 || (parts.length === 2 && parts[1] === "--confirm");
  if (action === "cutoff") return parts.length <= 2;
  if (["analytics", "review", "history", "unscored"].includes(action)) {
    return parts.length === 1 || (parts.length === 2 && positiveInteger(parts[1]));
  }
  if (action === "task") return parts.length >= 2;
  return false;
};

export const isRemovedExpCommand = (parts: string[]): boolean =>
  parts.length === 1 && parts[0]?.toLocaleLowerCase() === "sync";
