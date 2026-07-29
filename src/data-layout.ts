import { normalizePath, TFolder, type Vault } from "obsidian";
import { ensureFolders, type LayoutPathKind } from "./folder-layout";
import type { BrainSettings } from "./settings";

export const brainPath = (settings: BrainSettings, child = "") =>
  normalizePath([settings.brainFolder, child].filter(Boolean).join("/"));

export async function ensureBrainLayout(vault: Vault, settings: BrainSettings): Promise<void> {
  const folders = [
    "", "Chats", "Memory", "Calibration", "Coaching", "EXP", "EXP/Ledger", "Settings",
    "Queue", "Queue/EXP", "Queue/EXP/Pending", "Skills"
  ];
  const paths = folders.map((folder) => brainPath(settings, folder));
  await ensureFolders({
    getPathKind: async (path): Promise<LayoutPathKind> => {
      const indexed = vault.getAbstractFileByPath(path);
      if (indexed) return indexed instanceof TFolder ? "folder" : "file";
      return (await vault.adapter.stat(path))?.type ?? null;
    },
    createFolder: async (path) => {
      await vault.createFolder(path);
    }
  }, paths);
}
