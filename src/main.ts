import { Notice, Plugin, TFile, TFolder, normalizePath, type WorkspaceLeaf } from "obsidian";
import { brainPath, ensureBrainLayout } from "./data-layout";
import { BRAIN_VIEW_TYPE, BrainChatView } from "./chat-view";
import { BrainSettingTab, DEFAULT_SETTINGS, type BrainSettings } from "./settings";
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
import { TaskNotesProvider } from "./tasknotes-provider";
import { MarkdownTaskProvider } from "./markdown-task-provider";
import { TaskService } from "./task-service";
import { ExpService } from "./exp-service";
import { ExpAutoScorer } from "./exp-auto-scorer";
import { ExpCompletionQueueStore } from "./exp-completion-queue";
import { ExpCompletionCoordinator } from "./exp-completion";
import { PortableSettingsStore } from "./portable-settings";
import { MemoryService } from "./memory-service";

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
  taskService!: TaskService;
  expService!: ExpService;
  expAutoScorer!: ExpAutoScorer;
  expCompletionQueue!: ExpCompletionQueueStore;
  expCompletion!: ExpCompletionCoordinator;
  portableSettings!: PortableSettingsStore;
  memoryService!: MemoryService;
  readonly performance = new PerformanceTracer();
  private catalogCache: CatalogCache = {};
  private legacyCatalogCache: CatalogCache | null = null;
  private catalogStore!: CatalogStore;

  async onload(): Promise<void> {
    const finishOnload = this.performance.start("plugin.onload");
    let stage = "loading settings";
    try {
      await this.loadSettings();
      this.portableSettings = new PortableSettingsStore(this.app, () => this.settings);
      try {
        Object.assign(this.settings, await this.portableSettings.load());
      } catch (error) {
        console.warn("[Obsidian Brain] Portable settings are invalid; using the last valid plugin-data cache.", error);
        new Notice("Brain/Settings/config.md is invalid. Brain kept the last valid settings.", 0);
      }
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
      this.taskService = new TaskService(
        new TaskNotesProvider(this.app),
        new MarkdownTaskProvider(this.app, this.vaultTools, () => this.settings.fallbackTaskFolder),
        () => this.effectiveExcludedPaths(),
        this.sensitiveGuard
      );
      this.expService = new ExpService(
        this.app,
        this.vaultTools,
        this.taskService,
        () => brainPath(this.settings, "EXP"),
        () => this.settings.expTitleMaxLength
      );
      this.memoryService = new MemoryService(this.app, () => brainPath(this.settings, ""));
      this.expAutoScorer = new ExpAutoScorer(
        this.app,
        this.taskService,
        this.expService,
        this.openRouter,
        () => this.settings,
        (modelId) => this.getModel(modelId),
        async (paths) => {
          this.settings.autoExpQueue = paths;
          await this.saveLocalSettings();
        },
        (result) => new Notice(`Obsidian Brain scored ${result.title} at ${result.value} EXP.`),
        (path, error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (/Task not found/i.test(message)) return;
          console.error(`[Obsidian Brain] Automatic EXP scoring failed for ${path}.`, error);
          new Notice(`Automatic EXP scoring failed for ${path}: ${message}`, 0);
        }
      );
      this.expCompletionQueue = new ExpCompletionQueueStore(this.app, () => this.settings);
      this.expCompletion = new ExpCompletionCoordinator(
        this.taskService,
        this.expService,
        this.expAutoScorer,
        this.expCompletionQueue,
        () => this.settings,
        () => this.saveLocalSettings(),
        (title, value) => new Notice(`Obsidian Brain awarded ${value} EXP for ${title}.`),
        (path, error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[Obsidian Brain] Completion EXP failed for ${path}.`, error);
          new Notice(`Completion EXP failed for ${path}: ${message}`, 0);
        }
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
      this.agentTools = new AgentToolRegistry(
        this.vaultTools,
        this.retrievalIndex,
        this.skillRegistry,
        this.taskService,
        this.expService,
        this.memoryService,
        () => this.settings.autoScoreTaskExp,
        () => this.settings.interactiveModel,
        () => ({
          enabled: this.settings.detectCompletedTaskExp,
          automaticAwards: this.settings.autoAwardCompletedTaskExp,
          automaticScoring: this.settings.autoScoreCompletedTaskExp
        })
      );
      this.chatStore = new ChatStore(this.app, () => this.settings, this.performance);
      stage = "registering chat view";
      this.registerView(BRAIN_VIEW_TYPE, (leaf) => new BrainChatView(leaf, this));
      stage = "registering commands";
      this.addRibbonIcon("bot", "Open Obsidian Brain", () => void this.activateChat());
      this.addCommand({ id: "open-chat", name: "Open chat", callback: () => void this.activateChat() });
      this.addCommand({ id: "create-brain-layout", name: "Create or repair Brain data folders", callback: () => void this.ensureDataLayout() });
      this.addCommand({ id: "refresh-openrouter-models", name: "Refresh OpenRouter model catalog", callback: () => void this.refreshOpenRouterModels() });
      this.addCommand({
        id: "run-exp-on-active-task",
        name: "Run @exp on active TaskNote",
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          const available = file instanceof TFile && file.extension === "md";
          if (available && !checking) {
            void this.runBrainWorkflowOnActiveNote("@exp", file).catch((error) => this.reportError(error));
          }
          return available;
        }
      });
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
        void this.performance.measure("skills.initialize", () => this.skillRegistry.initialize())
          .catch((error) => this.reportError(error));
        void this.retrievalIndex.initialize().catch((error) => this.reportError(error));
        void (async () => {
          await this.ensureDataLayout();
          await this.portableSettings.save(this.settings);
          await this.initializeCatalogCache();
          this.expAutoScorer.resumeQueued();
          await this.expCompletion.initialize();
          if (this.settings.openRouterSecretId) {
            await this.refreshOpenRouterModels(false).catch((error) =>
              console.warn("[Obsidian Brain] Automatic model refresh failed.", error)
            );
          }
          if (this.settings.openRouterSecretId && (this.settings.semanticSearchEnabled || this.settings.embeddingModel)) {
            await this.refreshEmbeddingModels(false).catch((error) =>
              console.warn("[Obsidian Brain] Automatic embedding catalog refresh failed.", error)
            );
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

  async setExcludedPaths(paths: string[]): Promise<void> {
    this.settings.excludedPaths = [...new Set(paths.map((path) =>
      normalizePath(path.trim()).replace(/^\/+|\/+$/g, "")
    ).filter(Boolean))];
    await this.saveSettings();
    await this.rebuildPrivacyIndexes();
  }

  async setSensitiveTags(tags: string[]): Promise<void> {
    this.settings.sensitiveTags = [...new Set(tags
      .map((tag) => tag.trim().replace(/^#/, "").toLocaleLowerCase())
      .filter(Boolean))];
    await this.saveSettings();
    await this.rebuildPrivacyIndexes();
  }

  async setBrainFolder(value: string): Promise<void> {
    const next = normalizePath(value.trim() || "Brain").replace(/^\/+|\/+$/g, "");
    if (!next || next === "." || next === ".obsidian" || next.startsWith(".obsidian/") || next.includes("../")) {
      throw new Error("Brain folder must be a safe vault-relative folder outside .obsidian.");
    }
    const previous = normalizePath(this.settings.brainFolder).replace(/^\/+|\/+$/g, "");
    if (next === previous) return;
    if (next.startsWith(`${previous}/`)) {
      throw new Error("Brain data cannot be moved inside its current folder.");
    }
    const source = this.app.vault.getAbstractFileByPath(previous);
    const destination = this.app.vault.getAbstractFileByPath(next);
    if (destination) throw new Error(`Cannot move Brain data: ${next} already exists.`);
    if (source && !(source instanceof TFolder)) throw new Error(`Cannot move Brain data: ${previous} is not a folder.`);
    if (source instanceof TFolder) {
      const segments = next.split("/").slice(0, -1);
      let parent = "";
      for (const segment of segments) {
        parent = parent ? `${parent}/${segment}` : segment;
        const entry = this.app.vault.getAbstractFileByPath(parent);
        if (entry instanceof TFile) throw new Error(`Cannot create Brain folder: ${parent} is a file.`);
        if (!entry) await this.app.vault.createFolder(parent);
      }
      await this.app.fileManager.renameFile(source, next);
    }
    this.settings.brainFolder = next;
    await this.saveSettings();
    await this.ensureDataLayout();
    await this.skillRegistry.refresh();
    await this.rebuildPrivacyIndexes();
  }

  onunload(): void {
    this.expCompletion?.dispose();
    this.expAutoScorer?.dispose();
    this.semanticIndex?.dispose();
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

  async setAutoScoreTaskExp(enabled: boolean): Promise<void> {
    if (enabled && !this.settings.openRouterSecretId) {
      throw new Error("Choose an OpenRouter API key before enabling automatic EXP scoring.");
    }
    if (enabled && !(this.settings.backgroundModel || this.settings.interactiveModel)) {
      throw new Error("Choose a background model before enabling automatic EXP scoring.");
    }
    this.settings.autoScoreTaskExp = enabled;
    await this.saveSettings();
    if (!enabled) this.expAutoScorer.cancel();
  }

  async setCompletionDetectionEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.settings.completionExpBaselineReady) {
      await this.expCompletion.establishBaseline();
    }
    this.settings.detectCompletedTaskExp = enabled;
    await this.saveSettings();
  }

  async setAutomaticCompletionAwards(enabled: boolean): Promise<void> {
    this.settings.autoAwardCompletedTaskExp = enabled;
    await this.saveSettings();
  }

  async setAutomaticCompletionScoring(enabled: boolean): Promise<void> {
    if (enabled && !this.settings.openRouterSecretId) {
      throw new Error("Choose an OpenRouter API key before enabling automatic completion scoring.");
    }
    if (enabled && !(this.settings.backgroundModel || this.settings.interactiveModel)) {
      throw new Error("Choose a background model before enabling automatic completion scoring.");
    }
    this.settings.autoScoreCompletedTaskExp = enabled;
    await this.saveSettings();
  }

  async runBrainWorkflowOnActiveNote(workflow: string, file = this.app.workspace.getActiveFile()): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== "md") {
      throw new Error("Open a Markdown TaskNote before running a Brain workflow.");
    }
    if (workflow.trim().toLocaleLowerCase() !== "@exp") {
      throw new Error(`Unsupported active-note workflow: ${workflow}`);
    }
    const result = await this.expAutoScorer.scoreNow(file.path);
    new Notice(`Obsidian Brain stored ${result.value} EXP as ${result.title}.`);
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

  private async rebuildPrivacyIndexes(): Promise<void> {
    this.semanticIndex.cancel();
    await this.retrievalIndex.rebuild();
    if (this.settings.semanticSearchEnabled) {
      await this.semanticIndex.reconfigure();
    } else {
      await this.semanticIndex.removeSensitive();
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
    const fragment = await this.memoryService.create({
      category: "preference",
      content,
      confidence: 0.7,
      sensitivity: "low",
      source
    });
    new Notice("Obsidian Brain saved a low-risk memory fragment.");
    const file = this.app.vault.getAbstractFileByPath(fragment.path);
    if (!(file instanceof TFile)) throw new Error("Memory file could not be found after writing.");
    return file;
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData() ?? {}) as StoredPluginData;
    const { _catalogCache, ...storedSettings } = stored;
    this.legacyCatalogCache = _catalogCache ?? null;
    this.catalogCache = _catalogCache ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...storedSettings };
    this.settings.autoExpQueue = Array.isArray(this.settings.autoExpQueue)
      ? (this.settings.autoExpQueue as unknown[]).flatMap((value) => {
          if (typeof value === "string") return [{ path: value, attempts: 0, readyAt: Date.now() }];
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const entry = value as Record<string, unknown>;
          if (typeof entry.path !== "string") return [];
          return [{
            path: entry.path,
            attempts: typeof entry.attempts === "number" && Number.isFinite(entry.attempts)
              ? Math.max(0, Math.floor(entry.attempts))
              : 0,
            readyAt: typeof entry.readyAt === "number" && Number.isFinite(entry.readyAt)
              ? entry.readyAt
              : Date.now()
          }];
        })
      : [];
    this.settings.completionExpSeen = this.settings.completionExpSeen
      && typeof this.settings.completionExpSeen === "object"
      && !Array.isArray(this.settings.completionExpSeen)
      ? Object.fromEntries(Object.entries(this.settings.completionExpSeen).flatMap(([path, values]) =>
          Array.isArray(values)
          && values.every((value) => typeof value === "string")
            ? [[path, [...new Set(values)]]]
            : []
        ))
      : {};
    if (!Number.isFinite(this.settings.autoExpSpendCapUsd) || this.settings.autoExpSpendCapUsd < 0) {
      this.settings.autoExpSpendCapUsd = DEFAULT_SETTINGS.autoExpSpendCapUsd;
    }
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
    await this.portableSettings?.save(this.settings);
  }

  private async saveLocalSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async reloadPortableSettings(): Promise<void> {
    const previousOmnisearch = this.settings.useOmnisearch;
    const previousCompletionDetection = this.settings.detectCompletedTaskExp;
    const previousSemantic = JSON.stringify([
      this.settings.semanticSearchEnabled,
      this.settings.embeddingModel,
      this.settings.semanticFolders
    ]);
    const previousPrivacy = JSON.stringify([this.settings.excludedPaths, this.settings.sensitiveTags]);
    Object.assign(this.settings, await this.portableSettings.load());
    if (this.settings.semanticSearchEnabled && (!this.settings.embeddingModel || this.settings.semanticFolders.length === 0)) {
      this.settings.semanticSearchEnabled = false;
      new Notice("Brain portable settings requested semantic search without a model and folder scope; it remains disabled.");
    }
    if (
      !previousCompletionDetection
      && this.settings.detectCompletedTaskExp
      && !this.settings.completionExpBaselineReady
    ) {
      await this.expCompletion.establishBaseline();
    }
    await this.saveLocalSettings();
    const privacyChanged = previousPrivacy !== JSON.stringify([
      this.settings.excludedPaths,
      this.settings.sensitiveTags
    ]);
    if (privacyChanged) {
      await this.rebuildPrivacyIndexes();
    } else if (previousOmnisearch !== this.settings.useOmnisearch) {
      await this.reconfigureLexicalProvider();
    }
    if (!privacyChanged && previousSemantic !== JSON.stringify([
      this.settings.semanticSearchEnabled,
      this.settings.embeddingModel,
      this.settings.semanticFolders
    ])) {
      if (this.settings.semanticSearchEnabled) await this.semanticIndex.reconfigure();
      else this.semanticIndex.disable();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(BRAIN_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof BrainChatView) view.refreshModels();
    }
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
      if (file instanceof TFile) this.expAutoScorer.queue(file.path);
      if (file instanceof TFile) this.expCompletion.observe(file.path);
      if (this.portableSettings.isConfigPath(file.path)) {
        void this.reloadPortableSettings().catch((error) => this.reportError(error));
      }
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) void this.retrievalIndex.update(file).catch((error) => this.reportError(error));
      if (file instanceof TFile) this.semanticIndex.queueUpdate(file);
      if (file instanceof TFile) this.expAutoScorer.touch(file.path);
      if (file instanceof TFile) this.expCompletion.observe(file.path);
      if (this.portableSettings.isConfigPath(file.path)) {
        void this.reloadPortableSettings().catch((error) => this.reportError(error));
      }
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.expAutoScorer.forget(file.path);
      void this.expCompletion.forget(file.path);
      this.retrievalIndex.remove(file.path);
      void this.semanticIndex.remove(file.path).catch((error) => this.reportError(error));
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.retrievalIndex.remove(oldPath);
      void this.semanticIndex.remove(oldPath).catch((error) => this.reportError(error));
      if (file instanceof TFile) void this.retrievalIndex.update(file).catch((error) => this.reportError(error));
      if (file instanceof TFile) this.semanticIndex.queueUpdate(file);
      if (file instanceof TFile) {
        void this.expCompletion.rename(oldPath, file.path)
          .then(() => this.expCompletion.observe(file.path))
          .catch((error) => this.reportError(error));
      }
      refreshSkillIfNeeded(oldPath);
      refreshSkillIfNeeded(file.path);
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      void this.retrievalIndex.update(file, true).catch((error) => this.reportError(error));
      this.semanticIndex.queueUpdate(file);
      this.expAutoScorer.resolveCandidate(file.path);
      this.expCompletion.observe(file.path);
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
