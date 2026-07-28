export interface SkillInvocation {
  name: string;
  prompt: string;
}

export const parseSkillInvocation = (value: string): SkillInvocation | null => {
  const match = value.trim().match(/^@([a-z0-9-]{1,63})(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { name: match[1].toLocaleLowerCase(), prompt: (match[2] ?? "").trim() };
};
