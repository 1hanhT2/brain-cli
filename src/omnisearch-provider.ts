import type { App, TFile } from "obsidian";
import type { SensitiveContentGuard } from "./sensitive-content";

export interface OmnisearchApiResult {
  score: number;
  vault: string;
  path: string;
  basename: string;
  foundWords: string[];
  matches: Array<{ match: string; offset: number }>;
  excerpt: string;
}

export interface OmnisearchApi {
  search(query: string): Promise<OmnisearchApiResult[]>;
  refreshIndex(): Promise<void>;
  registerOnIndexed(callback: () => void): void;
  unregisterOnIndexed(callback: () => void): void;
}

export interface OmnisearchResult {
  path: string;
  heading: null;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  score: number;
  citation: string;
}

export interface OmnisearchStatus {
  enabled: boolean;
  available: boolean;
  active: boolean;
}

type ObsidianWithPlugins = App & {
  plugins?: {
    plugins?: Record<string, { api?: OmnisearchApi }>;
  };
};

type GlobalWithOmnisearch = typeof globalThis & {
  omnisearch?: OmnisearchApi;
};

const isOmnisearchApi = (value: unknown): value is OmnisearchApi =>
  Boolean(value)
  && typeof value === "object"
  && typeof (value as OmnisearchApi).search === "function";

const normalizeVaultPath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");

export class OmnisearchProvider {
  constructor(
    private readonly app: App,
    private readonly getEnabled: () => boolean,
    private readonly getExcludedPaths: () => string[],
    private readonly sensitiveGuard: SensitiveContentGuard
  ) {}

  getStatus(): OmnisearchStatus {
    const enabled = this.getEnabled();
    const available = Boolean(this.getApi());
    return { enabled, available, active: enabled && available };
  }

  async search(query: string, limit = 8): Promise<{
    results: OmnisearchResult[];
    skippedSensitiveNotes: number;
  } | null> {
    if (!this.getEnabled()) return null;
    const api = this.getApi();
    if (!api) return null;
    const trimmed = query.trim();
    if (!trimmed) return { results: [], skippedSensitiveNotes: 0 };

    let rawResults: OmnisearchApiResult[];
    try {
      rawResults = await api.search(trimmed);
    } catch (error) {
      console.warn("[Brain CLI] Omnisearch failed; using the built-in search fallback.", error);
      return null;
    }

    const cappedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
    const results: OmnisearchResult[] = [];
    let skippedSensitiveNotes = 0;
    for (const result of rawResults) {
      if (results.length >= cappedLimit) break;
      const path = normalizeVaultPath(result.path);
      if (!path.toLocaleLowerCase().endsWith(".md") || this.isExcluded(path)) continue;
      const abstractFile = this.app.vault.getAbstractFileByPath(path);
      if (!abstractFile || !("extension" in abstractFile) || abstractFile.extension !== "md") continue;
      const file = abstractFile as TFile;
      const content = await this.app.vault.cachedRead(file);
      if (this.sensitiveGuard.inspectFile(file, content).sensitive) {
        skippedSensitiveNotes += 1;
        continue;
      }

      const offset = this.findOffset(result, content);
      const lineStart = content.slice(0, offset).split(/\r?\n/).length;
      const excerpt = String(result.excerpt ?? "").replace(/\s+/g, " ").trim()
        || content.slice(Math.max(0, offset - 100), offset + 280).replace(/\s+/g, " ").trim();
      results.push({
        path,
        heading: null,
        lineStart,
        lineEnd: lineStart,
        excerpt,
        score: Number.isFinite(result.score) ? Number(result.score.toFixed(4)) : 0,
        citation: `[[${path.replace(/\.md$/i, "")}]]`
      });
    }
    return { results, skippedSensitiveNotes };
  }

  private getApi(): OmnisearchApi | null {
    const globalApi = (globalThis as GlobalWithOmnisearch).omnisearch;
    if (isOmnisearchApi(globalApi)) return globalApi;
    const pluginApi = (this.app as ObsidianWithPlugins).plugins?.plugins?.omnisearch?.api;
    return isOmnisearchApi(pluginApi) ? pluginApi : null;
  }

  private isExcluded(path: string): boolean {
    const normalized = normalizeVaultPath(path);
    return this.getExcludedPaths().some((excludedPath) => {
      const excluded = normalizeVaultPath(excludedPath);
      return Boolean(excluded) && (normalized === excluded || normalized.startsWith(`${excluded}/`));
    });
  }

  private findOffset(result: OmnisearchApiResult, content: string): number {
    const reported = result.matches?.find((match) => Number.isFinite(match.offset))?.offset;
    if (typeof reported === "number" && reported >= 0 && reported <= content.length) return reported;
    const contentLower = content.toLocaleLowerCase();
    for (const word of result.foundWords ?? []) {
      const found = contentLower.indexOf(word.toLocaleLowerCase());
      if (found >= 0) return found;
    }
    return 0;
  }
}
