import { Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { brainPath, ensureBrainLayout } from "./data-layout";
import { BRAIN_VIEW_TYPE, BrainChatView } from "./chat-view";
import { BrainSettingTab, DEFAULT_SETTINGS, type BrainSettings } from "./settings";
import type { MemoryFragment } from "./types";
import { VaultTools } from "./vault-tools";
import { OpenRouterClient } from "./openrouter";
import type { ChatMessage } from "./openrouter";
import type { OpenRouterModel } from "./types";
import { AgentToolRegistry } from "./agent-tools";
import { ChatStore } from "./chat-store";
import { compactConversation } from "./context-manager";
import type { ContextCompactionResult } from "./context-manager";
import { SensitiveContentGuard } from "./sensitive-content";
import { VaultRetrievalIndex } from "./retrieval-index";
import { OmnisearchProvider } from "./omnisearch-provider";
import { assembleOpenRouterTools } from "./openrouter-tools";
import { SkillRegistry } from "./skill-registry";

export default class ObsidianBrainPlugin extends Plugin {
  settings: BrainSettings = DEFAULT_SETTINGS;
  vaultTools!: VaultTools;
  agentTools!: AgentToolRegistry;
  chatStore!: ChatStore;
  sensitiveGuard!: SensitiveContentGuard;
  retrievalIndex!: VaultRetrievalIndex;
  omnisearchProvider!: OmnisearchProvider;
  skillRegistry!: SkillRegistry;
  modelCatalog: OpenRouterModel[] = [];
  openRouter!: OpenRouterClient;

  async onload(): Promise<void> {
    let stage = "loading settings";
    try {
      await this.loadSettings();
      stage = "ensuring Brain data layout";
      await this.ensureDataLayout();
      stage = "initializing services";
      this.sensitiveGuard = new SensitiveContentGuard(this.app, () => this.settings.sensitiveTags);
      this.omnisearchProvider = new OmnisearchProvider(
        this.app,
        () => this.settings.useOmnisearch,
        () => this.effectiveExcludedPaths(),
        this.sensitiveGuard
      );
      this.vaultTools = new VaultTools(
        this.app,
        () => this.effectiveExcludedPaths(),
        this.sensitiveGuard,
        this.omnisearchProvider
      );
      this.retrievalIndex = new VaultRetrievalIndex(
        this.app,
        () => this.effectiveExcludedPaths(),
        this.sensitiveGuard,
        this.omnisearchProvider
      );
      this.skillRegistry = new SkillRegistry(this.app, () => this.settings);
      await this.skillRegistry.initialize();
      this.agentTools = new AgentToolRegistry(this.vaultTools, this.retrievalIndex, this.skillRegistry);
      this.chatStore = new ChatStore(this.app, () => this.settings);
      this.openRouter = new OpenRouterClient(this.app, () => this.settings.openRouterSecretId);
      stage = "registering chat view";
      this.registerView(BRAIN_VIEW_TYPE, (leaf) => new BrainChatView(leaf, this));
      stage = "registering commands";
      this.addRibbonIcon("bot", "Open Obsidian Brain", () => void this.activateChat());
      this.addCommand({ id: "open-chat", name: "Open chat", callback: () => void this.activateChat() });
      this.addCommand({ id: "create-brain-layout", name: "Create or repair Brain data folders", callback: () => void this.ensureDataLayout() });
      this.addCommand({ id: "refresh-openrouter-models", name: "Refresh OpenRouter model catalog", callback: () => void this.refreshOpenRouterModels() });
      stage = "registering settings";
      this.addSettingTab(new BrainSettingTab(this.app, this));
      stage = "scheduling vault layout";
      this.registerVaultIndexEvents();
      this.app.workspace.onLayoutReady(() => {
        void this.ensureDataLayout().catch((error) => this.reportError(error));
        void this.retrievalIndex.initialize().catch((error) => this.reportError(error));
        if (this.settings.openRouterSecretId) {
          void this.refreshOpenRouterModels(false).catch((error) =>
            console.warn("[Obsidian Brain] Automatic model refresh failed.", error)
          );
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Obsidian Brain] Startup failed while ${stage}.`, error);
      new Notice(`Obsidian Brain startup failed while ${stage}: ${message}`, 0);
      throw error;
    }
  }

  async rebuildRetrievalIndex(): Promise<void> {
    await this.retrievalIndex.initialize();
    new Notice(`Obsidian Brain indexed ${this.retrievalIndex.getStatus().indexedNotes} notes.`);
  }

  onunload(): void {
    void this.app.workspace.detachLeavesOfType(BRAIN_VIEW_TYPE);
  }

  async activateChat(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(BRAIN_VIEW_TYPE)[0];
    const leaf: WorkspaceLeaf = existing ?? this.app.workspace.getRightLeaf(false)!;
    await leaf.setViewState({ type: BRAIN_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async ensureDataLayout(): Promise<void> {
    await ensureBrainLayout(this.app.vault, this.settings);
  }

  async refreshOpenRouterModels(showNotice = true): Promise<void> {
    if (showNotice) this.openRouter.clearModelRankingCache();
    this.modelCatalog = await this.openRouter.listModels();
    if (showNotice) new Notice(`Obsidian Brain loaded ${this.modelCatalog.length} OpenRouter models.`);
    for (const leaf of this.app.workspace.getLeavesOfType(BRAIN_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof BrainChatView) view.refreshModels();
    }
  }

  getModel(modelId = this.settings.interactiveModel): OpenRouterModel | undefined {
    return this.modelCatalog.find((model) => model.id === modelId);
  }

  async compactChatContext(messages: ChatMessage[], signal: AbortSignal): Promise<ContextCompactionResult> {
    const model = this.getModel();
    const contextLength = model?.context_length ?? model?.top_provider?.context_length ?? 32_768;
    const toolDefinitionTokens = Math.ceil(JSON.stringify(this.activeRequestTools()).length / 4);
    const effectiveContextLength = Math.max(4_096, contextLength - toolDefinitionTokens);
    return compactConversation(messages, effectiveContextLength, async (transcript) =>
      this.openRouter.completeText(
        this.settings.backgroundModel || this.settings.interactiveModel,
        "Summarize the earlier portion of an Obsidian assistant conversation. Preserve decisions, user preferences, unresolved tasks, note paths, tool outcomes, and constraints. Be concise and factual.",
        transcript,
        signal
      )
    );
  }

  streamChatCompletion(
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
    signal: AbortSignal
  ) {
    return this.openRouter.streamChatCompletion(
      this.settings.interactiveModel,
      messages,
      this.activeRequestTools(),
      onDelta,
      signal
    );
  }

  private activeRequestTools() {
    return assembleOpenRouterTools(this.agentTools.definitions(), this.settings.useWebSearch);
  }

  reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`Obsidian Brain: ${message}`);
    console.error("[Obsidian Brain]", error);
  }

  async saveLowRiskMemory(content: string, source: string): Promise<TFile> {
    const timestamp = new Date().toISOString();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fragment: MemoryFragment = {
      id,
      category: "preference",
      content,
      confidence: 0.7,
      sensitivity: "low",
      createdAt: timestamp,
      source,
      status: "active"
    };
    const path = brainPath(this.settings, `Memory/${id}.md`);
    const markdown = `---\nid: ${fragment.id}\ntype: memory\ncategory: ${fragment.category}\nconfidence: ${fragment.confidence}\nsensitivity: ${fragment.sensitivity}\ncreated: ${fragment.createdAt}\nsource: ${JSON.stringify(fragment.source)}\nstatus: ${fragment.status}\n---\n\n${fragment.content}\n`;
    const file = await this.app.vault.create(path, markdown);
    new Notice("Obsidian Brain saved a low-risk memory fragment.");
    return file;
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() as Partial<BrainSettings> ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private registerVaultIndexEvents(): void {
    const refreshSkillIfNeeded = (path: string) => {
      const skillRoot = brainPath(this.settings, "Skills");
      if (path === skillRoot || path.startsWith(`${skillRoot}/`)) {
        void this.skillRegistry.refresh().catch((error) => this.reportError(error));
      }
    };
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) void this.retrievalIndex.update(file).catch((error) => this.reportError(error));
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) void this.retrievalIndex.update(file).catch((error) => this.reportError(error));
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.retrievalIndex.remove(file.path);
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.retrievalIndex.remove(oldPath);
      if (file instanceof TFile) void this.retrievalIndex.update(file).catch((error) => this.reportError(error));
      refreshSkillIfNeeded(oldPath);
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      void this.retrievalIndex.update(file).catch((error) => this.reportError(error));
    }));
  }

  private effectiveExcludedPaths(): string[] {
    return [...new Set([
      ...this.settings.excludedPaths,
      brainPath(this.settings, "Chats"),
      brainPath(this.settings, "Skills")
    ])];
  }
}
