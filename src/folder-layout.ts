export type LayoutPathKind = "folder" | "file" | null;

export interface FolderLayoutAdapter {
  getPathKind(path: string): Promise<LayoutPathKind>;
  createFolder(path: string): Promise<void>;
}

export async function ensureFolders(adapter: FolderLayoutAdapter, paths: string[]): Promise<void> {
  for (const path of paths) {
    const existing = await adapter.getPathKind(path);
    if (existing === "folder") continue;
    if (existing === "file") {
      throw new Error(`Cannot create Brain folder because a file exists at ${path}.`);
    }

    try {
      await adapter.createFolder(path);
    } catch (error) {
      // Folder creation and Obsidian's Vault index can race during startup or
      // when two layout repairs run concurrently.
      if (await adapter.getPathKind(path) === "folder") continue;
      throw error;
    }
  }
}
