import { App, PluginSettingTab, SecretComponent, Setting, normalizePath } from "obsidian";
import type ObsidianBrainPlugin from "./main";

export interface BrainSettings {
  brainFolder: string;
  openRouterSecretId: string;
  interactiveModel: string;
  backgroundModel: string;
  favoriteModels: string[];
  useOmnisearch: boolean;
  excludedPaths: string[];
  sensitiveTags: string[];
}

export const DEFAULT_SETTINGS: BrainSettings = {
  brainFolder: "Brain",
  openRouterSecretId: "",
  interactiveModel: "openrouter/free",
  backgroundModel: "openrouter/free",
  favoriteModels: ["openrouter/free"],
  useOmnisearch: false,
  excludedPaths: [".obsidian", "Brain/Chats", "Brain/Skills"],
  sensitiveTags: ["private", "sensitive", "secret", "confidential"]
};

export class BrainSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianBrainPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian Brain" });

    new Setting(containerEl)
      .setName("Brain folder")
      .setDesc("Synced conversations, memories, calibration, and non-secret preferences live here.")
      .addText((text) => text
        .setValue(this.plugin.settings.brainFolder)
        .onChange(async (value) => {
          this.plugin.settings.brainFolder = normalizePath(value.trim() || "Brain");
          await this.plugin.saveSettings();
          await this.plugin.ensureDataLayout();
        }));

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
      .setDesc("Reserved for future task scoring, summaries, and memory extraction.")
      .addText((text) => text
        .setValue(this.plugin.settings.backgroundModel)
        .onChange(async (value) => {
          this.plugin.settings.backgroundModel = value.trim() || "openrouter/free";
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
        }));

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc("Comma-separated paths that retrieval must never index or send to a model.")
      .addTextArea((text) => text
        .setValue(this.plugin.settings.excludedPaths.join(", "))
        .onChange(async (value) => {
          this.plugin.settings.excludedPaths = value.split(",").map((item) => normalizePath(item.trim())).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Sensitive tags")
      .setDesc("Comma-separated tags that require approval before a note can be sent to a model.")
      .addText((text) => text
        .setValue(this.plugin.settings.sensitiveTags.join(", "))
        .onChange(async (value) => {
          this.plugin.settings.sensitiveTags = value
            .split(",")
            .map((item) => item.trim().replace(/^#/, "").toLocaleLowerCase())
            .filter(Boolean);
          await this.plugin.saveSettings();
        }));

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
