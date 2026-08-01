import { normalizePath, parseYaml, TFile, type App } from "obsidian";
import { frontmatterSensitivityReasons } from "./privacy-policy";

export interface SensitivityReport {
  sensitive: boolean;
  reasons: string[];
}

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "private key material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { label: "OpenAI/OpenRouter-style API key", pattern: /\bsk-(?:or-v1-)?[a-zA-Z0-9_-]{20,}\b/ },
  { label: "credential-like assignment", pattern: /\b(?:api[_ -]?key|access[_ -]?token|password|secret)\b\s*[:=]\s*["']?[^\s"']{8,}/i }
];

const normalizeTag = (tag: string): string =>
  tag.trim().replace(/^#/, "").toLocaleLowerCase();

export class SensitiveContentGuard {
  constructor(
    private readonly app: App,
    private readonly getSensitiveTags: () => string[]
  ) {}

  async inspectPath(path: string): Promise<SensitivityReport> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile) || file.extension !== "md") {
      throw new Error(`Markdown file not found: ${path}`);
    }
    return this.inspectFile(file, await this.app.vault.cachedRead(file));
  }

  inspectFile(file: TFile, content: string): SensitivityReport {
    const reasons: string[] = [];
    const configuredTags = new Set(this.getSensitiveTags().map(normalizeTag));
    const cache = this.app.metadataCache.getFileCache(file);
    let parsedFrontmatter: Record<string, unknown> = {};
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (frontmatterMatch) {
      try {
        parsedFrontmatter = parseYaml(frontmatterMatch[1]) as Record<string, unknown> ?? {};
      } catch {
        // Invalid YAML is handled by Obsidian elsewhere; secret-pattern checks still apply.
      }
    }
    const frontmatter = { ...(cache?.frontmatter ?? {}), ...parsedFrontmatter };
    const rawTags = [
      ...(Array.isArray(frontmatter?.tags) ? frontmatter.tags : [frontmatter?.tags]),
      ...(cache?.tags?.map((tag) => tag.tag) ?? [])
    ].filter((tag): tag is string => typeof tag === "string")
      .flatMap((tag) => tag.split(/[\s,]+/))
      .map(normalizeTag);
    const matchedTags = [...new Set(rawTags.filter((tag) => configuredTags.has(tag)))];
    if (matchedTags.length > 0) reasons.push(`sensitive tag: ${matchedTags.map((tag) => `#${tag}`).join(", ")}`);
    reasons.push(...frontmatterSensitivityReasons(frontmatter));
    for (const candidate of SECRET_PATTERNS) {
      if (candidate.pattern.test(content)) reasons.push(candidate.label);
    }
    return { sensitive: reasons.length > 0, reasons };
  }
}
