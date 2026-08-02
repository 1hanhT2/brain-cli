const trimVaultPath = (value: string): string =>
  value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

export const pathMatchesExclusion = (path: string, excludedPaths: string[]): boolean => {
  const normalized = trimVaultPath(path);
  return excludedPaths.some((candidate) => {
    const excluded = trimVaultPath(candidate);
    return Boolean(excluded) && (normalized === excluded || normalized.startsWith(`${excluded}/`));
  });
};

export const effectivePrivacyExclusions = (
  excludedPaths: string[],
  brainFolder: string
): string[] => {
  const root = trimVaultPath(brainFolder);
  return [...new Set([
    ...excludedPaths.map(trimVaultPath).filter(Boolean),
    ...["Chats", "Memory", "Skills", "Coaching"].map((folder) => `${root}/${folder}`)
  ])];
};

export const frontmatterSensitivityReasons = (frontmatter: Record<string, unknown>): string[] => {
  const reasons: string[] = [];
  if (frontmatter.sensitive === true) reasons.push("frontmatter marks the note as sensitive");
  if (String(frontmatter.sensitivity ?? "").trim().toLocaleLowerCase() === "review") {
    reasons.push("frontmatter marks the note as review-only");
  }
  const privacy = String(frontmatter.privacy ?? "").trim();
  if (["private", "confidential", "secret"].includes(privacy.toLocaleLowerCase())) {
    reasons.push(`privacy: ${privacy}`);
  }
  return reasons;
};
