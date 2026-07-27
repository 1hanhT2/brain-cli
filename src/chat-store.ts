import { normalizePath, TFile, type App } from "obsidian";
import { brainPath } from "./data-layout";
import type { BrainSettings } from "./settings";
import {
  decodeChatState,
  renderChatMarkdown,
  slugifyChatTitle,
  type ChatState,
  type ChatSummary
} from "./chat-format";

export class ChatStore {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => BrainSettings
  ) {}

  async list(): Promise<ChatSummary[]> {
    const folder = brainPath(this.getSettings(), "Chats");
    const summaries: ChatSummary[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${folder}/`)) continue;
      try {
        const state = decodeChatState(await this.app.vault.cachedRead(file));
        summaries.push({
          id: state.id,
          title: state.title,
          path: file.path,
          updatedAt: state.updatedAt,
          model: state.model
        });
      } catch {
        // Non-chat Markdown in the Chats folder remains untouched.
      }
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async create(title: string, model: string, messages: ChatState["messages"]): Promise<ChatState> {
    const timestamp = new Date().toISOString();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const path = await this.uniquePath(title, id);
    const state: ChatState = {
      id,
      title,
      path,
      createdAt: timestamp,
      updatedAt: timestamp,
      model,
      messages
    };
    await this.app.vault.create(path, renderChatMarkdown(state));
    return state;
  }

  async load(path: string): Promise<ChatState> {
    const file = this.requireChatFile(path);
    const state = decodeChatState(await this.app.vault.cachedRead(file));
    state.path = file.path;
    return state;
  }

  async save(state: ChatState): Promise<ChatState> {
    const file = this.requireChatFile(state.path);
    const updated = {
      ...state,
      path: file.path,
      updatedAt: new Date().toISOString()
    };
    await this.app.vault.modify(file, renderChatMarkdown(updated));
    return updated;
  }

  async rename(state: ChatState, title: string): Promise<ChatState> {
    const cleanTitle = title.replace(/\s+/g, " ").trim();
    if (!cleanTitle) throw new Error("Chat title cannot be empty.");
    const file = this.requireChatFile(state.path);
    const target = await this.uniquePath(cleanTitle, state.id, file.path);
    if (target !== file.path) await this.app.fileManager.renameFile(file, target);
    return this.save({ ...state, title: cleanTitle, path: target });
  }

  async remove(state: ChatState): Promise<void> {
    const file = this.requireChatFile(state.path);
    await this.app.vault.trash(file, false);
  }

  private requireChatFile(path: string): TFile {
    const folder = brainPath(this.getSettings(), "Chats");
    const normalized = normalizePath(path);
    if (!normalized.startsWith(`${folder}/`) || !normalized.endsWith(".md")) {
      throw new Error("Chat path is outside the configured Brain/Chats folder.");
    }
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) throw new Error(`Chat file not found: ${normalized}`);
    return file;
  }

  private async uniquePath(title: string, id: string, currentPath?: string): Promise<string> {
    const folder = brainPath(this.getSettings(), "Chats");
    const base = `${slugifyChatTitle(title)}-${id.slice(-6)}`;
    let path = normalizePath(`${folder}/${base}.md`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path) && path !== currentPath) {
      path = normalizePath(`${folder}/${base}-${suffix}.md`);
      suffix += 1;
    }
    return path;
  }
}
