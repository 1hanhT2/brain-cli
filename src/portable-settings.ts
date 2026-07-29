import { normalizePath, parseYaml, TFile, type App } from "obsidian";
import { brainPath } from "./data-layout";
import type { BrainSettings } from "./settings";

const CONFIG_SCHEMA = 1;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type PortableBrainSettings = Pick<BrainSettings,
  | "fallbackTaskFolder"
  | "interactiveModel"
  | "backgroundModel"
  | "autoExpSpendCapUsd"
  | "expTitleMaxLength"
  | "favoriteModels"
  | "embeddingModel"
  | "favoriteEmbeddingModels"
  | "useOmnisearch"
  | "useWebSearch"
  | "semanticSearchEnabled"
  | "semanticFolders"
  | "semanticSpendCapUsd"
  | "excludedPaths"
  | "sensitiveTags"
  | "detectCompletedTaskExp"
>;

const portableKeys: Array<keyof PortableBrainSettings> = [
  "fallbackTaskFolder",
  "interactiveModel",
  "backgroundModel",
  "autoExpSpendCapUsd",
  "expTitleMaxLength",
  "favoriteModels",
  "embeddingModel",
  "favoriteEmbeddingModels",
  "useOmnisearch",
  "useWebSearch",
  "semanticSearchEnabled",
  "semanticFolders",
  "semanticSpendCapUsd",
  "excludedPaths",
  "sensitiveTags",
  "detectCompletedTaskExp"
];

const aliases: Record<keyof PortableBrainSettings, string> = {
  fallbackTaskFolder: "fallback_task_folder",
  interactiveModel: "interactive_model",
  backgroundModel: "background_model",
  autoExpSpendCapUsd: "auto_exp_spend_cap_usd",
  expTitleMaxLength: "exp_title_max_length",
  favoriteModels: "favorite_models",
  embeddingModel: "embedding_model",
  favoriteEmbeddingModels: "favorite_embedding_models",
  useOmnisearch: "use_omnisearch",
  useWebSearch: "use_web_search",
  semanticSearchEnabled: "semantic_search_enabled",
  semanticFolders: "semantic_folders",
  semanticSpendCapUsd: "semantic_spend_cap_usd",
  excludedPaths: "excluded_paths",
  sensitiveTags: "sensitive_tags",
  detectCompletedTaskExp: "detect_completed_task_exp"
};

const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.map((item) => item.trim()).filter(Boolean)
    : null;

export const portableSettingsFrom = (settings: BrainSettings): PortableBrainSettings =>
  Object.fromEntries(portableKeys.map((key) => [key, settings[key]])) as PortableBrainSettings;

export class PortableSettingsStore {
  private lastContent = "";

  constructor(
    private readonly app: App,
    private readonly getSettings: () => BrainSettings
  ) {}

  path(): string {
    return brainPath(this.getSettings(), "Settings/config.md");
  }

  async loadOrCreate(settings: BrainSettings): Promise<Partial<PortableBrainSettings>> {
    const file = this.app.vault.getAbstractFileByPath(this.path());
    if (!(file instanceof TFile)) {
      await this.save(settings);
      return {};
    }
    const content = await this.app.vault.cachedRead(file);
    this.lastContent = content;
    return this.parse(content);
  }

  async load(): Promise<Partial<PortableBrainSettings>> {
    const file = this.app.vault.getAbstractFileByPath(this.path());
    if (!(file instanceof TFile)) return {};
    const content = await this.app.vault.cachedRead(file);
    this.lastContent = content;
    return this.parse(content);
  }

  async save(settings: BrainSettings): Promise<void> {
    const content = this.render(portableSettingsFrom(settings));
    if (content === this.lastContent) return;
    const path = this.path();
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
    this.lastContent = content;
  }

  isConfigPath(path: string): boolean {
    return normalizePath(path) === this.path();
  }

  private parse(content: string): Partial<PortableBrainSettings> {
    const match = content.match(FRONTMATTER_PATTERN);
    if (!match) throw new Error("Brain portable settings require YAML frontmatter.");
    const row = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
    if (row.type !== "brain-settings") throw new Error("Brain portable settings have an invalid type.");
    if (row.schema !== CONFIG_SCHEMA) throw new Error(`Unsupported Brain settings schema: ${String(row.schema)}.`);
    const result: Partial<PortableBrainSettings> = {};
    for (const key of portableKeys) {
      const value = row[aliases[key]];
      if (value === undefined) continue;
      if (key === "fallbackTaskFolder") {
        if (typeof value === "string" && value.trim()) result[key] = normalizePath(value.trim());
      } else if (key === "interactiveModel" || key === "backgroundModel" || key === "embeddingModel") {
        if (typeof value === "string") result[key] = value.trim();
      } else if (
        key === "favoriteModels"
        || key === "favoriteEmbeddingModels"
        || key === "semanticFolders"
        || key === "excludedPaths"
        || key === "sensitiveTags"
      ) {
        const values = stringArray(value);
        if (values) (result as Record<string, unknown>)[key] = values;
      } else if (
        key === "useOmnisearch"
        || key === "useWebSearch"
        || key === "semanticSearchEnabled"
        || key === "detectCompletedTaskExp"
      ) {
        if (typeof value === "boolean") (result as Record<string, unknown>)[key] = value;
      } else if (key === "expTitleMaxLength") {
        if (typeof value === "number" && Number.isInteger(value) && value >= 30 && value <= 200) {
          result[key] = value;
        }
      } else if (key === "autoExpSpendCapUsd" || key === "semanticSpendCapUsd") {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          (result as Record<string, unknown>)[key] = value;
        }
      }
    }
    return result;
  }

  private render(settings: PortableBrainSettings): string {
    const lines = [
      "---",
      "type: brain-settings",
      `schema: ${CONFIG_SCHEMA}`
    ];
    for (const key of portableKeys) {
      lines.push(`${aliases[key]}: ${JSON.stringify(settings[key])}`);
    }
    lines.push(
      "---",
      "",
      "# Brain CLI settings",
      "",
      "This is the human-readable source for portable, non-secret Brain preferences.",
      "Use Brain's `/config` menu or Obsidian settings when possible; direct edits are validated before being applied.",
      "",
      "The OpenRouter secret, explicit automatic-write and sensitive-data consent, cache identifiers, indexes, and embeddings remain device-local.",
      ""
    );
    return lines.join("\n");
  }
}
