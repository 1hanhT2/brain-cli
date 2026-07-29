const SKILL_ALIASES: Record<string, string[]> = {
  "continual-writing-coach": ["cwc"]
};

export const canonicalSkillName = (name: string): string => {
  const normalized = name.trim().toLocaleLowerCase();
  for (const [canonical, aliases] of Object.entries(SKILL_ALIASES)) {
    if (aliases.includes(normalized)) return canonical;
  }
  return normalized;
};

export const skillAliases = (name: string): string[] =>
  [...(SKILL_ALIASES[canonicalSkillName(name)] ?? [])];
