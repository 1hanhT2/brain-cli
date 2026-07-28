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
import type { PerformanceTracer } from "./performance";

interface CachedChatSummary {
  modifiedAt: number;
  summary: ChatSummary;
}

export class ChatStore {
  private readonly summaryCache = new Map<string, CachedChatSummary>();

  constructor(
    private readonly app: App,
    private readonly getSettings: () => BrainSettings,
    private readonly performance?: PerformanceTracer
  ) {}

  async list(): Promise<ChatSummary[]> {
    return this.performance?.measure("chats.list", () => this.listUnmeasured())
      ?? this.listUnmeasured();
  }

  private async listUnmeasured(): Promise<ChatSummary[]> {
    const folder = brainPath(this.getSettings(), "Chats");
    const summaries: ChatSummary[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${folder}/`)) continue;
      const cached = this.summaryCache.get(file.path);
      if (cached && cached.modifiedAt === file.stat.mtime) {
        summaries.push(cached.summary);
        continue;
      }
      try {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const summary = this.summaryFromFrontmatter(file, frontmatter)
          ?? this.summaryFromState(file, decodeChatState(await this.app.vault.cachedRead(file)));
        this.summaryCache.set(file.path, { modifiedAt: file.stat.mtime, summary });
        summaries.push(summary);
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
    this.cacheState(state);
    return state;
  }

  async load(path: string): Promise<ChatState> {
    const file = this.requireChatFile(path);
    const state = decodeChatState(await this.app.vault.cachedRead(file));
    state.path = file.path;
    return state;
  }

  async save(state: ChatState): Promise<ChatState> {
    const file = this.requireChatFile(state.path, state.id);
    const updated = {
      ...state,
      path: file.path,
      updatedAt: new Date().toISOString()
    };
    await this.app.vault.modify(file, renderChatMarkdown(updated));
    this.cacheState(updated);
    return updated;
  }

  async rename(state: ChatState, title: string): Promise<ChatState> {
    const cleanTitle = title.replace(/\s+/g, " ").trim();
    if (!cleanTitle) throw new Error("Chat title cannot be empty.");
    const file = this.requireChatFile(state.path, state.id);
    const target = await this.uniquePath(cleanTitle, state.id, file.path);
    if (target !== file.path) await this.app.fileManager.renameFile(file, target);
    return this.save({ ...state, title: cleanTitle, path: target });
  }

  async remove(state: ChatState): Promise<void> {
    const file = this.requireChatFile(state.path, state.id);
    this.summaryCache.delete(file.path);
    await this.app.vault.trash(file, false);
  }

  private requireChatFile(path: string, chatId?: string): TFile {
    const folder = brainPath(this.getSettings(), "Chats");
    const normalized = normalizePath(path);
    if (normalized.startsWith(`${folder}/`) && normalized.endsWith(".md")) {
      const file = this.app.vault.getAbstractFileByPath(normalized);
      if (file instanceof TFile) return file;
    }
    if (chatId) {
      const moved = this.app.vault.getMarkdownFiles().find((file) =>
        file.path.startsWith(`${folder}/`)
        && this.app.metadataCache.getFileCache(file)?.frontmatter?.brain_chat_id === chatId
      );
      if (moved) return moved;
    }
    throw new Error("Chat file was not found inside the configured Brain/Chats folder.");
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

  private summaryFromFrontmatter(file: TFile, frontmatter: Record<string, unknown> | undefined): ChatSummary | null {
    if (
      frontmatter?.type !== "brain-chat"
      || typeof frontmatter.brain_chat_id !== "string"
      || typeof frontmatter.title !== "string"
      || typeof frontmatter.updated !== "string"
      || typeof frontmatter.model !== "string"
    ) return null;
    return {
      id: frontmatter.brain_chat_id,
      title: frontmatter.title,
      path: file.path,
      updatedAt: frontmatter.updated,
      model: frontmatter.model
    };
  }

  private summaryFromState(file: TFile, state: ChatState): ChatSummary {
    return {
      id: state.id,
      title: state.title,
      path: file.path,
      updatedAt: state.updatedAt,
      model: state.model
    };
  }

  private cacheState(state: ChatState): void {
    const file = this.app.vault.getAbstractFileByPath(state.path);
    this.summaryCache.set(state.path, {
      modifiedAt: file instanceof TFile ? file.stat.mtime : 0,
      summary: this.summaryFromState(
        file instanceof TFile ? file : ({ path: state.path } as TFile),
        state
      )
    });
  }
}
