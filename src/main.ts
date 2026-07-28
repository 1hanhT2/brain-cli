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
import { IndexedDbSemanticStore } from "./semantic-store";
import { SemanticIndexCoordinator } from "./semantic-index";
import type { EmbeddingModel } from "./semantic-types";
import { PerformanceTracer } from "./performance";
import { IndexedDbLexicalIndexStore } from "./retrieval-store";
import { IndexedDbCatalogStore, type CatalogStore } from "./catalog-store";
import { compactEmbeddingModel, compactOpenRouterModel } from "./catalog-models";

interface CatalogCache {
  models?: { fetchedAt: number; rows: OpenRouterModel[] };
  embeddings?: { fetchedAt: number; rows: EmbeddingModel[] };
}

type StoredPluginData = Partial<BrainSettings> & { _catalogCache?: CatalogCache };

const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

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
  embeddingModelCatalog: EmbeddingModel[] = [];
  openRouter!: OpenRouterClient;
  semanticIndex!: SemanticIndexCoordinator;
  readonly performance = new PerformanceTracer();
  private catalogCache: CatalogCache = {};
  private legacyCatalogCache: CatalogCache | null = null;
  private catalogStore!: CatalogStore;

  async onload(): Promise<void> {
    const finishOnload = this.performance.start("plugin.onload");
    let stage = "loading settings";
    try {
      await this.loadSettings();
      stage = "initializing services";
      this.openRouter = new OpenRouterClient(this.app, () => this.settings.openRouterSecretId);
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
      const semanticStore = new IndexedDbSemanticStore(`obsidian-brain:${this.settings.semanticVaultId}`);
      this.catalogStore = new IndexedDbCatalogStore(`obsidian-brain-catalogs:${this.settings.semanticVaultId}`);
      this.semanticIndex = new SemanticIndexCoordinator(
        this.app,
        () => this.settings,
        () => this.effectiveExcludedPaths(),
        this.sensitiveGuard,
        semanticStore,
        this.openRouter,
        () => this.embeddingModelCatalog
      );
      this.retrievalIndex = new VaultRetrievalIndex(
        this.app,
        () => this.effectiveExcludedPaths(),
        this.sensitiveGuard,
        this.omnisearchProvider,
        this.semanticIndex,
        new IndexedDbLexicalIndexStore(`obsidian-brain-lexical:${this.settings.semanticVaultId}`),
        this.performance
      );
      this.skillRegistry = new SkillRegistry(this.app, () => this.settings);
      this.agentTools = new AgentToolRegistry(this.vaultTools, this.retrievalIndex, this.skillRegistry);
      this.chatStore = new ChatStore(this.app, () => this.settings, this.performance);
      stage = "registering chat view";
      this.registerView(BRAIN_VIEW_TYPE, (leaf) => new BrainChatView(leaf, this));
      stage = "registering commands";
      this.addRibbonIcon("bot", "Open Obsidian Brain", () => void this.activateChat());
      this.addCommand({ id: "open-chat", name: "Open chat", callback: () => void this.activateChat() });
      this.addCommand({ id: "create-brain-layout", name: "Create or repair Brain data folders", callback: () => void this.ensureDataLayout() });
      this.addCommand({ id: "refresh-openrouter-models", name: "Refresh OpenRouter model catalog", callback: () => void this.refreshOpenRouterModels() });
      this.addCommand({
        id: "show-performance-diagnostics",
        name: "Show performance diagnostics",
        callback: () => new Notice(this.performance.report(), 0)
      });
      stage = "registering settings";
      this.addSettingTab(new BrainSettingTab(this.app, this));
      stage = "scheduling vault layout";
      this.registerVaultIndexEvents();
      this.app.workspace.onLayoutReady(() => {
        void this.ensureDataLayout().catch((error) => this.reportError(error));
        void this.performance.measure("skills.initialize", () => this.skillRegistry.initialize())
          .catch((error) => this.reportError(error));
        void this.retrievalIndex.initialize().catch((error) => this.reportError(error));
        void (async () => {
          await this.initializeCatalogCache();
          if (this.settings.openRouterSecretId) {
            await this.refreshOpenRouterModels(false).catch((error) =>
              console.warn("[Obsidian Brain] Automatic model refresh failed.", error)
            );
          }
          if (this.settings.openRouterSecretId && (this.settings.semanticSearchEnabled || this.settings.embeddingModel)) {
            await this.refreshEmbeddingModels(false);
          }
          await this.semanticIndex.initialize();
        })().catch((error) => this.reportError(error));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Obsidian Brain] Startup failed while ${stage}.`, error);
      new Notice(`Obsidian Brain startup failed while ${stage}: ${message}`, 0);
      throw error;
    } finally {
      finishOnload();
    }
  }

  async rebuildRetrievalIndex(): Promise<void> {
    await this.retrievalIndex.rebuild();
    new Notice(`Obsidian Brain indexed ${this.retrievalIndex.getStatus().indexedNotes} notes.`);
  }

  async reconfigureLexicalProvider(): Promise<void> {
    await this.retrievalIndex.initialize();
  }

  onunload(): void {
    this.semanticIndex?.cancel();
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
    if (!showNotice && this.isCatalogFresh(this.catalogCache.models)) {
      this.modelCatalog = this.catalogCache.models!.rows;
      return;
    }
    if (showNotice) this.openRouter.clearModelRankingCache();
    this.modelCatalog = await this.performance.measure("catalog.models.fetch", () => this.openRouter.listModels());
    this.catalogCache.models = { fetchedAt: Date.now(), rows: this.modelCatalog };
    await this.catalogStore.set("models", this.catalogCache.models);
    if (showNotice) new Notice(`Obsidian Brain loaded ${this.modelCatalog.length} OpenRouter models.`);
    for (const leaf of this.app.workspace.getLeavesOfType(BRAIN_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof BrainChatView) view.refreshModels();
    }
  }

  async refreshEmbeddingModels(showNotice = true): Promise<void> {
    if (!showNotice && this.isCatalogFresh(this.catalogCache.embeddings)) {
      this.embeddingModelCatalog = this.catalogCache.embeddings!.rows;
      return;
    }
    this.embeddingModelCatalog = await this.performance.measure(
      "catalog.embeddings.fetch",
      () => this.openRouter.listEmbeddingModels()
    );
    this.catalogCache.embeddings = { fetchedAt: Date.now(), rows: this.embeddingModelCatalog };
    await this.catalogStore.set("embeddings", this.catalogCache.embeddings);
    if (showNotice) new Notice(`Obsidian Brain loaded ${this.embeddingModelCatalog.length} embedding models.`);
  }

  async selectEmbeddingModel(modelId: string): Promise<void> {
    const normalized = modelId.trim();
    if (normalized === this.settings.embeddingModel) return;
    this.settings.embeddingModel = normalized;
    await this.saveSettings();
    await this.semanticIndex.clear();
    if (this.settings.semanticSearchEnabled && normalized) {
      void this.semanticIndex.start("rebuild").catch((error) => this.reportError(error));
    }
  }

  async setSemanticSearchEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.settings.embeddingModel) {
      throw new Error("Choose an embedding model before enabling semantic search.");
    }
    if (enabled && this.settings.semanticFolders.length === 0) {
      throw new Error("Choose at least one folder before enabling semantic search.");
    }
    this.settings.semanticSearchEnabled = enabled;
    await this.saveSettings();
    if (enabled) void this.semanticIndex.start("enable").catch((error) => this.reportError(error));
    else this.semanticIndex.disable();
  }

  async setSensitiveSemanticEnabled(enabled: boolean): Promise<void> {
    this.settings.includeSensitiveSemantic = enabled;
    await this.saveSettings();
    if (!enabled) await this.semanticIndex.removeSensitive();
    if (this.settings.semanticSearchEnabled) {
      void this.semanticIndex.reconfigure().catch((error) => this.reportError(error));
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
    const stored = (await this.loadData() ?? {}) as StoredPluginData;
    const { _catalogCache, ...storedSettings } = stored;
    this.legacyCatalogCache = _catalogCache ?? null;
    this.catalogCache = _catalogCache ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...storedSettings };
    this.modelCatalog = this.catalogCache.models?.rows ?? [];
    this.embeddingModelCatalog = this.catalogCache.embeddings?.rows ?? [];
    let shouldSave = Boolean(_catalogCache);
    if (!this.settings.semanticVaultId) {
      this.settings.semanticVaultId = typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      shouldSave = true;
    }
    if (shouldSave) await this.saveSettings();
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
      if (file instanceof TFile) this.semanticIndex.queueUpdate(file);
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) void this.retrievalIndex.update(file).catch((error) => this.reportError(error));
      if (file instanceof TFile) this.semanticIndex.queueUpdate(file);
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.retrievalIndex.remove(file.path);
      void this.semanticIndex.remove(file.path).catch((error) => this.reportError(error));
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.retrievalIndex.remove(oldPath);
      void this.semanticIndex.remove(oldPath).catch((error) => this.reportError(error));
      if (file instanceof TFile) void this.retrievalIndex.update(file).catch((error) => this.reportError(error));
      if (file instanceof TFile) this.semanticIndex.queueUpdate(file);
      refreshSkillIfNeeded(oldPath);
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      void this.retrievalIndex.update(file, true).catch((error) => this.reportError(error));
      this.semanticIndex.queueUpdate(file);
    }));
  }

  private isCatalogFresh(cache: { fetchedAt: number } | undefined): boolean {
    return Boolean(cache && Date.now() - cache.fetchedAt < CATALOG_CACHE_TTL_MS);
  }

  private async initializeCatalogCache(): Promise<void> {
    await this.performance.measure("catalog.cache.load", async () => {
      await this.catalogStore.initialize();
      if (this.legacyCatalogCache) {
        const models = this.legacyCatalogCache.models
          ? {
              fetchedAt: this.legacyCatalogCache.models.fetchedAt,
              rows: this.legacyCatalogCache.models.rows.map(compactOpenRouterModel)
            }
          : undefined;
        const embeddings = this.legacyCatalogCache.embeddings
          ? {
              fetchedAt: this.legacyCatalogCache.embeddings.fetchedAt,
              rows: this.legacyCatalogCache.embeddings.rows.map(compactEmbeddingModel)
            }
          : undefined;
        if (models) await this.catalogStore.set("models", models);
        if (embeddings) await this.catalogStore.set("embeddings", embeddings);
        this.catalogCache = { models, embeddings };
        this.legacyCatalogCache = null;
      } else {
        const [models, embeddings] = await Promise.all([
          this.catalogStore.get<CatalogCache["models"]>("models"),
          this.catalogStore.get<CatalogCache["embeddings"]>("embeddings")
        ]);
        this.catalogCache = { models, embeddings };
      }
      this.modelCatalog = this.catalogCache.models?.rows ?? this.modelCatalog;
      this.embeddingModelCatalog = this.catalogCache.embeddings?.rows ?? this.embeddingModelCatalog;
      for (const leaf of this.app.workspace.getLeavesOfType(BRAIN_VIEW_TYPE)) {
        const view = leaf.view;
        if (view instanceof BrainChatView) view.refreshModels();
      }
    });
  }

  private effectiveExcludedPaths(): string[] {
    return [...new Set([
      ...this.settings.excludedPaths,
      brainPath(this.settings, "Chats"),
      brainPath(this.settings, "Skills")
    ])];
  }
}
