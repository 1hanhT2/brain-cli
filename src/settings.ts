import { App, PluginSettingTab, SecretComponent, Setting, normalizePath } from "obsidian";
import type BrainCliPlugin from "./main";

export interface AutoExpQueueEntry {
  path: string;
  attempts: number;
  readyAt: number;
}

export interface BrainSettings {
  brainFolder: string;
  fallbackTaskFolder: string;
  openRouterSecretId: string;
  interactiveModel: string;
  backgroundModel: string;
  autoScoreTaskExp: boolean;
  autoExpSpendCapUsd: number;
  autoExpQueue: AutoExpQueueEntry[];
  detectCompletedTaskExp: boolean;
  autoAwardCompletedTaskExp: boolean;
  autoScoreCompletedTaskExp: boolean;
  completionExpSeen: Record<string, string[]>;
  completionExpBaselineReady: boolean;
  expTitleMaxLength: number;
  favoriteModels: string[];
  embeddingModel: string;
  favoriteEmbeddingModels: string[];
  useOmnisearch: boolean;
  useWebSearch: boolean;
  semanticSearchEnabled: boolean;
  semanticFolders: string[];
  includeSensitiveSemantic: boolean;
  semanticSpendCapUsd: number;
  semanticVaultId: string;
  excludedPaths: string[];
  sensitiveTags: string[];
  bundledSkillsVersion: number;
}

export const DEFAULT_SETTINGS: BrainSettings = {
  brainFolder: "Brain",
  fallbackTaskFolder: "TaskNotes/Tasks",
  openRouterSecretId: "",
  interactiveModel: "openrouter/free",
  backgroundModel: "openrouter/free",
  autoScoreTaskExp: false,
  autoExpSpendCapUsd: 0.10,
  autoExpQueue: [],
  detectCompletedTaskExp: false,
  autoAwardCompletedTaskExp: false,
  autoScoreCompletedTaskExp: false,
  completionExpSeen: {},
  completionExpBaselineReady: false,
  expTitleMaxLength: 100,
  favoriteModels: ["openrouter/free"],
  embeddingModel: "",
  favoriteEmbeddingModels: [],
  useOmnisearch: false,
  useWebSearch: false,
  semanticSearchEnabled: false,
  semanticFolders: [],
  includeSensitiveSemantic: false,
  semanticSpendCapUsd: 0.25,
  semanticVaultId: "",
  excludedPaths: [".obsidian", "Brain/Chats", "Brain/Skills"],
  sensitiveTags: ["private", "sensitive", "secret", "confidential"],
  bundledSkillsVersion: 0
};

export class BrainSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: BrainCliPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Brain CLI" });

    new Setting(containerEl)
      .setName("Brain folder")
      .setDesc("Synced conversations, memories, calibration, and non-secret preferences live here.")
      .addText((text) => {
        let pending = this.plugin.settings.brainFolder;
        text.setValue(pending).onChange((value) => { pending = value; });
        text.inputEl.addEventListener("change", () => {
          void this.plugin.setBrainFolder(pending).then(() => this.display()).catch((error) => {
            text.setValue(this.plugin.settings.brainFolder);
            this.plugin.reportError(error);
          });
        });
      });

    new Setting(containerEl)
      .setName("OpenRouter API key")
      .setDesc("Stored in Obsidian SecretStorage, not in the vault or synced settings.")
      .addComponent((component) => new SecretComponent(this.app, component)
        .setValue(this.plugin.settings.openRouterSecretId)
        .onChange(async (secretId) => {
          this.plugin.settings.openRouterSecretId = secretId;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Fallback task folder")
      .setDesc("Folder used for generic Markdown tasks when the TaskNotes runtime API is unavailable.")
      .addText((text) => text
        .setValue(this.plugin.settings.fallbackTaskFolder)
        .onChange(async (value) => {
          this.plugin.settings.fallbackTaskFolder = normalizePath(value.trim() || "TaskNotes/Tasks");
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Model catalog")
      .setDesc("Fetch the current model catalog after selecting an OpenRouter secret.")
      .addButton((button) => button
        .setButtonText("Refresh models")
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Refreshing…");
          try {
            await this.plugin.refreshOpenRouterModels();
            button.setButtonText("Refreshed");
          } catch (error) {
            this.plugin.reportError(error);
            button.setButtonText("Try again");
          } finally {
            window.setTimeout(() => button.setDisabled(false).setButtonText("Refresh models"), 1000);
          }
        }));

    new Setting(containerEl)
      .setName("Interactive model")
      .setDesc("The model selected when starting a new chat.")
      .addText((text) => text
        .setValue(this.plugin.settings.interactiveModel)
        .onChange(async (value) => {
          this.plugin.settings.interactiveModel = value.trim() || "openrouter/free";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Background model")
      .setDesc("Used for automatic EXP scoring, summaries, and memory extraction.")
      .addText((text) => text
        .setValue(this.plugin.settings.backgroundModel)
        .onChange(async (value) => {
          this.plugin.settings.backgroundModel = value.trim() || "openrouter/free";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Automatically score new TaskNotes")
      .setDesc("Opt in to sending newly created, non-sensitive task content to the background OpenRouter model. Brain writes planned EXP and prefixes the real title without another approval.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoScoreTaskExp)
        .onChange(async (value) => {
          if (value && !window.confirm(
            "New non-sensitive TaskNotes will be sent to OpenRouter and updated automatically. Model usage may cost money. Enable automatic EXP scoring?"
          )) {
            toggle.setValue(false);
            return;
          }
          try {
            await this.plugin.setAutoScoreTaskExp(value);
          } catch (error) {
            toggle.setValue(!value);
            this.plugin.reportError(error);
          }
        }));

    new Setting(containerEl)
      .setName("Detect completed task EXP")
      .setDesc("Watch TaskNotes and fallback Markdown tasks for newly completed work. Existing completions are baselined when first enabled.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.detectCompletedTaskExp)
        .onChange(async (value) => {
          try {
            await this.plugin.setCompletionDetectionEnabled(value);
          } catch (error) {
            toggle.setValue(!value);
            this.plugin.reportError(error);
          }
        }));

    new Setting(containerEl)
      .setName("Automatically commit completion awards")
      .setDesc("Write detected awards without per-task approval. When disabled, proposals remain in Brain/Queue/EXP/Pending.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoAwardCompletedTaskExp)
        .onChange(async (value) => {
          if (value && !window.confirm(
            "Detected task completions will update task frontmatter and write EXP ledger entries automatically. Continue?"
          )) {
            toggle.setValue(false);
            return;
          }
          try {
            await this.plugin.setAutomaticCompletionAwards(value);
          } catch (error) {
            toggle.setValue(!value);
            this.plugin.reportError(error);
          }
        }));

    new Setting(containerEl)
      .setName("Automatically score unscored completions")
      .setDesc("Send completed non-sensitive task notes without planned EXP to the background OpenRouter model. Otherwise they remain marked needs-score.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoScoreCompletedTaskExp)
        .onChange(async (value) => {
          if (value && !window.confirm(
            "Unscored completed task content will be sent to OpenRouter and may incur model charges. Continue?"
          )) {
            toggle.setValue(false);
            return;
          }
          try {
            await this.plugin.setAutomaticCompletionScoring(value);
          } catch (error) {
            toggle.setValue(!value);
            this.plugin.reportError(error);
          }
        }));

    new Setting(containerEl)
      .setName("EXP task title length")
      .setDesc("Maximum stored TaskNote title length after adding [EXP]. Longer titles are shortened at a word boundary.")
      .addText((text) => text
        .setValue(String(this.plugin.settings.expTitleMaxLength))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isInteger(parsed) || parsed < 30 || parsed > 200) return;
          this.plugin.settings.expTitleMaxLength = parsed;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Automatic EXP spend cap")
      .setDesc("Maximum estimated USD spend per plugin session for automatic scoring. Manual @exp scoring is unaffected. Use 0 for unlimited.")
      .addText((text) => text
        .setValue(String(this.plugin.settings.autoExpSpendCapUsd))
        .onChange(async (value) => {
          const parsed = Number.parseFloat(value);
          if (!Number.isFinite(parsed) || parsed < 0) return;
          this.plugin.settings.autoExpSpendCapUsd = parsed;
          await this.plugin.saveSettings();
        }));

    const omnisearch = this.plugin.omnisearchProvider.getStatus();
    new Setting(containerEl)
      .setName("Use Omnisearch")
      .setDesc(omnisearch.available
        ? "Use the installed Omnisearch index for lexical retrieval. Brain still filters excluded and sensitive notes."
        : "Omnisearch is not currently detected. Brain will use its built-in lexical index as a fallback.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useOmnisearch)
        .onChange(async (value) => {
          this.plugin.settings.useOmnisearch = value;
          await this.plugin.saveSettings();
          await this.plugin.reconfigureLexicalProvider();
        }));

    new Setting(containerEl)
      .setName("Allow OpenRouter web search")
      .setDesc("Expose OpenRouter's server-side web search tool. A 5xx retries once through its legacy model-agnostic web plugin. Search use may add provider charges.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useWebSearch)
        .onChange(async (value) => {
          this.plugin.settings.useWebSearch = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Semantic search")
      .setDesc("Build a local per-device vector index with OpenRouter embeddings. Choose a model and folders first.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.semanticSearchEnabled)
        .onChange(async (value) => {
          try {
            await this.plugin.setSemanticSearchEnabled(value);
          } catch (error) {
            toggle.setValue(false);
            this.plugin.reportError(error);
          }
        }));

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc(`Use the dedicated paged browser in Brain chat. Current: ${this.plugin.settings.embeddingModel || "none"}. Changing it clears and rebuilds semantic vectors.`)
      .addButton((button) => button
        .setButtonText("Open Brain")
        .onClick(async () => {
          await this.plugin.activateChat();
        }));

    new Setting(containerEl)
      .setName("Semantic folders")
      .setDesc(`Selected: ${this.plugin.settings.semanticFolders.join(", ") || "none"}. Descendant folders are included.`)
      .addButton((button) => button
        .setButtonText("Open picker")
        .onClick(async () => {
          await this.plugin.activateChat();
        }));

    new Setting(containerEl)
      .setName("Embedding spend cap")
      .setDesc("Maximum estimated USD cost for one indexing job. Use 0 for unlimited.")
      .addText((text) => text
        .setValue(String(this.plugin.settings.semanticSpendCapUsd))
        .onChange(async (value) => {
          const parsed = Number.parseFloat(value);
          if (!Number.isFinite(parsed) || parsed < 0) return;
          this.plugin.settings.semanticSpendCapUsd = parsed;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Include sensitive notes in semantic search")
      .setDesc("Global consent: sensitive chunks are sent to OpenRouter for embedding and may be retrieved automatically by the agent.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.includeSensitiveSemantic)
        .onChange(async (value) => {
          if (value) {
            const embeddingConsent = window.confirm(
              "Sensitive note text will be sent to OpenRouter to create embeddings. Continue?"
            );
            const retrievalConsent = embeddingConsent && window.confirm(
              "The agent may retrieve sensitive excerpts without another approval while this remains enabled. Confirm?"
            );
            if (!retrievalConsent) {
              toggle.setValue(false);
              return;
            }
          }
          await this.plugin.setSensitiveSemanticEnabled(value);
        }));

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc("Comma-separated paths that retrieval must never index or send to a model.")
      .addTextArea((text) => {
        let pending = this.plugin.settings.excludedPaths.join(", ");
        text.setValue(pending).onChange((value) => { pending = value; });
        text.inputEl.addEventListener("change", () => {
          void this.plugin.setExcludedPaths(
            pending.split(",").map((item) => normalizePath(item.trim())).filter(Boolean)
          ).catch((error) => this.plugin.reportError(error));
        });
      });

    new Setting(containerEl)
      .setName("Sensitive tags")
      .setDesc("Comma-separated tags that require approval before a note can be sent to a model.")
      .addText((text) => {
        let pending = this.plugin.settings.sensitiveTags.join(", ");
        text.setValue(pending).onChange((value) => { pending = value; });
        text.inputEl.addEventListener("change", () => {
          void this.plugin.setSensitiveTags(pending.split(",")).catch((error) => this.plugin.reportError(error));
        });
      });

    new Setting(containerEl)
      .setName("Retrieval index")
      .setDesc("Rebuild after changing exclusions or sensitive tags. The index also updates automatically as notes change.")
      .addButton((button) => button
        .setButtonText("Rebuild index")
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Rebuilding…");
          try {
            await this.plugin.rebuildRetrievalIndex();
          } catch (error) {
            this.plugin.reportError(error);
          } finally {
            button.setDisabled(false).setButtonText("Rebuild index");
          }
        }));
  }
}
