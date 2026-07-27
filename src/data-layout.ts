import { normalizePath, type Vault } from "obsidian";
import type { BrainSettings } from "./settings";

export const brainPath = (settings: BrainSettings, child = "") =>
  normalizePath([settings.brainFolder, child].filter(Boolean).join("/"));

export async function ensureBrainLayout(vault: Vault, settings: BrainSettings): Promise<void> {
  const folders = ["", "Chats", "Memory", "Calibration", "Settings", "Queue"];
  for (const folder of folders) {
    const path = brainPath(settings, folder);
    if (!vault.getAbstractFileByPath(path)) await vault.createFolder(path);
  }
}
