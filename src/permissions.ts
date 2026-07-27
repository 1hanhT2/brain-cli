import type { ToolRisk } from "./types";

export const requiresApproval = (risk: ToolRisk): boolean =>
  risk !== "read";

export const isVaultPathSafe = (path: string): boolean => {
  const raw = path.replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw) || /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(raw)) return false;
  const normalized = raw.replace(/^\/+/, "");
  return normalized.length > 0
    && !normalized.startsWith("../")
    && !normalized.includes("/../")
    && normalized !== ".obsidian"
    && !normalized.startsWith(".obsidian/");
};
