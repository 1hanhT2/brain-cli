import { App, PluginSettingTab, SecretComponent, Setting, normalizePath } from "obsidian";
import type ObsidianBrainPlugin from "./main";

export interface BrainSettings {
  brainFolder: string;
  openRouterSecretId: string;
  interactiveModel: string;
  backgroundModel: string;
  favoriteModels: string[];
  excludedPaths: string[];
}

export const DEFAULT_SETTINGS: BrainSettings = {
  brainFolder: "Brain",
  openRouterSecretId: "",
  interactiveModel: "openrouter/free",
  backgroundModel: "openrouter/free",
  favoriteModels: ["openrouter/free"],
  excludedPaths: [".obsidian", "Brain/Chats"]
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

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc("Comma-separated paths that retrieval must never index or send to a model.")
      .addTextArea((text) => text
        .setValue(this.plugin.settings.excludedPaths.join(", "))
        .onChange(async (value) => {
          this.plugin.settings.excludedPaths = value.split(",").map((item) => normalizePath(item.trim())).filter(Boolean);
          await this.plugin.saveSettings();
        }));
  }
}
