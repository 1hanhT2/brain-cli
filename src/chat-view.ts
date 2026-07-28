import {
  ItemView,
  Component,
  MarkdownRenderer,
  Modal,
  Notice,
  Setting,
  TFolder,
  setIcon,
  type App,
  type WorkspaceLeaf
} from "obsidian";
import type ObsidianBrainPlugin from "./main";
import type { ChatMessage, ToolCall } from "./openrouter";
import { requiresApproval } from "./permissions";
import type { ToolRisk, OpenRouterModel } from "./types";
import type { EmbeddingModel, RetrievalMode, SemanticIndexStatus } from "./semantic-types";
import { titleFromMessage, type ChatState, type ChatSummary } from "./chat-format";
import type { ToolPreview } from "./agent-tools";
import { paginate, readLeadingPage, type Page } from "./pagination";
import {
  rankPopularModels,
  rankingDateRange,
  rankTrendingModels,
  type ModelUsageRanking
} from "./model-rankings";

export const BRAIN_VIEW_TYPE = "obsidian-brain-chat";

interface BrainCommand {
  name: string;
  usage: string;
  description: string;
}

interface ConfigMenuItem {
  id: string;
  label: string;
  description: string;
  checked: () => boolean;
  detail: () => string;
  toggle: () => Promise<void>;
}

const MODEL_FILTERS = new Set(["all", "popular", "trending", "free", "paid", "favorites"]);
const EMBEDDING_FILTERS = new Set(["all", "favorites"]);
const TRANSCRIPT_INITIAL_MESSAGES = 40;
const TRANSCRIPT_PAGE_MESSAGES = 40;

const commandTokens = (value: string): string[] =>
  [...value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((token): token is string => token !== undefined);

const BRAIN_COMMANDS: BrainCommand[] = [
  { name: "help", usage: "/help [page]", description: "Show the paged command reference" },
  { name: "status", usage: "/status", description: "Show the active vault, chat, model, retrieval, and skills" },
  { name: "perf", usage: "/perf [reset]", description: "Show local plugin performance measurements" },
  { name: "new", usage: "/new", description: "Start a new chat" },
  { name: "chats", usage: "/chats [page] [query]", description: "List saved chats" },
  { name: "open", usage: "/open <number|title>", description: "Open a saved chat from /chats" },
  { name: "rename", usage: "/rename <title>", description: "Rename the current chat" },
  { name: "delete", usage: "/delete --confirm", description: "Move the current chat to vault trash" },
  { name: "models", usage: "/models [all|popular|trending|free|paid|favorites] [window] [page] [query]", description: "List paged OpenRouter models" },
  { name: "model", usage: "/model <number|id>", description: "Switch model using /models results or an exact ID" },
  { name: "favorite", usage: "/favorite [number|id]", description: "Toggle a model favorite" },
  { name: "refresh", usage: "/refresh", description: "Refresh the OpenRouter model catalog" },
  { name: "embeddings", usage: "/embeddings [all|favorites] [page] [query]", description: "List paged OpenRouter embedding models" },
  { name: "embedding", usage: "/embedding <number|id> [--confirm]", description: "Select the semantic embedding model" },
  { name: "embedding-favorite", usage: "/embedding-favorite [number|id]", description: "Toggle an embedding model favorite" },
  { name: "skills", usage: "/skills [page]", description: "List installed SKILL.md skills" },
  { name: "skill", usage: "/skill <name>", description: "Activate a skill for this conversation" },
  { name: "exp", usage: "/exp [status|history|review|task|calibrate]", description: "View EXP progress, ledger history, task scores, and calibration" },
  { name: "memory", usage: "/memory <text>", description: "Save a low-risk Markdown memory fragment" },
  { name: "search", usage: "/search <query> [--mode hybrid|semantic|lexical]", description: "Search the vault and show cited excerpts" },
  { name: "index", usage: "/index status|rebuild|pause|resume|cancel|clear", description: "Inspect and control retrieval indexing" },
  { name: "semantic", usage: "/semantic folders|cap <usd|unlimited>", description: "Configure semantic indexing" },
  { name: "config", usage: "/config", description: "Open the terminal settings menu" },
  { name: "setting", usage: "/setting", description: "Alias for /config" },
  { name: "settings", usage: "/settings", description: "Open the terminal settings menu (/settings native for Obsidian settings)" },
  { name: "clear", usage: "/clear", description: "Clear terminal output while retaining conversation context" },
  { name: "approve", usage: "/approve", description: "Approve the pending tool action" },
  { name: "deny", usage: "/deny", description: "Deny the pending tool action" },
  { name: "stop", usage: "/stop", description: "Stop the active generation" }
];

const createSystemMessage = (): ChatMessage => ({
  role: "system",
  content: [
    "[Obsidian Brain system v2]",
    "You are Obsidian Brain, a concise and thoughtful agent operating inside an Obsidian vault.",
    "You have real tools for inspecting the environment and listing, reading, searching, creating, replacing, and updating frontmatter on permitted Markdown notes.",
    "You can query, inspect, create, update, and complete TaskNotes tasks through the active task provider.",
    "You can use the EXP tools to plan, award, review, and persist accomplishment-first task EXP. Use record_task_exp instead of generic frontmatter writes for EXP.",
    "Use tools whenever the answer depends on the vault instead of guessing or merely describing safety.",
    "When the OpenRouter web search server tool is available, use it for current or external information instead of relying on potentially stale training knowledge.",
    "When asked what you can do or what environment you are in, call get_environment and explain the returned capabilities and limitations plainly.",
    "When vault tools return citations, cite the supporting notes with those exact Obsidian wikilinks.",
    "A skill returned by get_environment or list_skills is installed and available. A skill becomes active for the current conversation only after its [Active skill: name] system message is present. Never say an available skill is not installed merely because it was not previously active.",
    "Read tools run automatically. Direct sensitive-note reads require approval; semantic retrieval may include sensitive excerpts only when the user's global semantic consent is enabled. Every write requires explicit approval.",
    "Never claim that a tool succeeded unless its result says ok=true. Treat tool results as the source of truth."
  ].join("\n")
});

class TextPromptModal extends Modal {
  private value: string;
  private settled = false;
  private resolve!: (value: string | null) => void;
  readonly result = new Promise<string | null>((resolve) => { this.resolve = resolve; });

  constructor(app: App, private readonly heading: string, initialValue: string) {
    super(app);
    this.value = initialValue;
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.heading });
    new Setting(this.contentEl)
      .setName("Title")
      .addText((text) => {
        text.setValue(this.value).onChange((value) => { this.value = value; });
        window.setTimeout(() => {
          text.inputEl.focus();
          text.inputEl.select();
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            this.finish(this.value.trim() || null);
          }
        });
      });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(null));
    actions.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () =>
      this.finish(this.value.trim() || null)
    );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(null);
    }
  }

  private finish(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
    this.close();
  }
}

class ConfirmModal extends Modal {
  private settled = false;
  private resolve!: (value: boolean) => void;
  readonly result = new Promise<boolean>((resolve) => { this.resolve = resolve; });

  constructor(app: App, private readonly heading: string, private readonly message: string) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.heading });
    this.contentEl.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(false));
    actions.createEl("button", { text: "Move to vault trash", cls: "mod-warning" }).addEventListener("click", () =>
      this.finish(true)
    );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
  }

  private finish(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
    this.close();
  }
}

export class BrainChatView extends ItemView {
  private transcriptEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private contextChatEl!: HTMLElement;
  private contextModelEl!: HTMLElement;
  private chatSelect!: HTMLSelectElement;
  private renameChatButton!: HTMLButtonElement;
  private deleteChatButton!: HTMLButtonElement;
  private newChatButton!: HTMLButtonElement;
  private modelSelect!: HTMLSelectElement;
  private modelSearch!: HTMLInputElement;
  private modelFilter!: HTMLSelectElement;
  private modelRefreshButton!: HTMLButtonElement;
  private favoriteButton!: HTMLButtonElement;
  private modelDetailsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private commandSuggestionsEl!: HTMLElement;
  private commandHintEl!: HTMLElement;
  private abortController: AbortController | null = null;
  private pendingApproval: { finish: (approved: boolean) => void } | null = null;
  private activeAssistantBody: HTMLElement | null = null;
  private activePartial = "";
  private messages: ChatMessage[] = [createSystemMessage()];
  private currentChat: ChatState | null = null;
  private chatSummaries: ChatSummary[] = [];
  private readonly markdownComponents = new Map<HTMLElement, Component>();
  private readonly turnCitations = new Set<string>();
  private commandHistory: string[] = [];
  private historyIndex = 0;
  private suggestionIndex = 0;
  private visibleSuggestions: BrainCommand[] = [];
  private lastModelResults: OpenRouterModel[] = [];
  private lastEmbeddingResults: EmbeddingModel[] = [];
  private lastChatResults: ChatSummary[] = [];
  private configMenuEl: HTMLElement | null = null;
  private configMenuSelection = 0;
  private configMenuBusy = false;
  private sensitiveConsentPending = false;
  private folderPickerEl: HTMLElement | null = null;
  private folderPickerSelection = 0;
  private folderPickerFolders: string[] = [];
  private folderPickerSelected = new Set<string>();
  private folderPickerEnableAfterConfirm = false;
  private unsubscribeSemantic: (() => void) | null = null;
  private semanticProgressEl: HTMLElement | null = null;
  private transcriptVisibleStart: number | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ObsidianBrainPlugin) {
    super(leaf);
  }

  getViewType(): string { return BRAIN_VIEW_TYPE; }
  getDisplayText(): string { return this.currentChat?.title ?? "Obsidian Brain"; }
  getIcon(): string { return "bot"; }

  refreshModels(): void {
    if (!this.modelSelect) return;
    this.refreshModelOptions();
    this.renderModelDetails();
  }

  async onOpen(): Promise<void> {
    const finish = this.plugin.performance.start("view.open");
    try {
      this.containerEl.empty();
      this.containerEl.addClass("obsidian-brain-view");
      this.renderHeader();
      this.transcriptEl = this.containerEl.createDiv({ cls: "obsidian-brain-transcript" });
      this.renderEmptyState();
      this.renderComposer();
      await this.refreshChatSummaries();
      this.unsubscribeSemantic = this.plugin.semanticIndex.subscribe((status) => this.renderSemanticStatus(status));
    } finally {
      finish();
    }
  }

  async onClose(): Promise<void> {
    this.abortController?.abort();
    this.closeConfigMenu(false);
    this.closeFolderPicker(false);
    this.unsubscribeSemantic?.();
    this.unsubscribeSemantic = null;
    this.disposeMarkdownComponents();
  }

  private renderHeader(): void {
    const header = this.containerEl.createDiv({ cls: "obsidian-brain-header" });
    const titleRow = header.createDiv({ cls: "obsidian-brain-title-row" });
    const identity = titleRow.createDiv({ cls: "obsidian-brain-identity" });
    identity.createSpan({ cls: "obsidian-brain-terminal-mark", text: "●" });
    identity.createEl("h3", { text: "brain" });
    identity.createSpan({ cls: "obsidian-brain-vault", text: `@${this.app.vault.getName()}` });
    this.statusEl = titleRow.createSpan({ cls: "obsidian-brain-status", text: "ready" });

    const contextRow = header.createDiv({ cls: "obsidian-brain-context-row" });
    contextRow.createSpan({ cls: "obsidian-brain-context-prefix", text: "~/" });
    this.contextChatEl = contextRow.createSpan({ cls: "obsidian-brain-context-chat", text: "new" });
    contextRow.createSpan({ cls: "obsidian-brain-context-divider", text: "│" });
    this.contextModelEl = contextRow.createSpan({ cls: "obsidian-brain-context-model" });
    this.modelDetailsEl = contextRow.createSpan({ cls: "obsidian-brain-model-details" });

    // Native controls remain as an accessibility/state fallback. The terminal
    // command layer is the primary interface.
    const internal = header.createDiv({ cls: "obsidian-brain-internal-controls" });
    const chatRow = internal.createDiv();
    this.chatSelect = chatRow.createEl("select", { attr: { "aria-label": "Saved chat" } });
    this.chatSelect.addEventListener("change", () => {
      if (this.chatSelect.value) void this.openChat(this.chatSelect.value);
    });
    this.newChatButton = this.iconButton(chatRow, "plus", "New chat", () => this.startNewChat());
    this.renameChatButton = this.iconButton(chatRow, "pencil", "Rename chat", () => void this.renameCurrentChat());
    this.deleteChatButton = this.iconButton(chatRow, "trash-2", "Delete chat", () => void this.deleteCurrentChat());

    const browserRow = internal.createDiv();
    this.modelSearch = browserRow.createEl("input", {
      type: "search",
      attr: { placeholder: "Search models…", "aria-label": "Search OpenRouter models" }
    });
    this.modelSearch.addEventListener("input", () => this.refreshModelOptions());
    this.modelFilter = browserRow.createEl("select", { attr: { "aria-label": "Filter models" } });
    this.modelFilter.createEl("option", { value: "all", text: "All models" });
    this.modelFilter.createEl("option", { value: "favorites", text: "Favorites" });
    this.modelFilter.createEl("option", { value: "free", text: "Free" });
    this.modelFilter.createEl("option", { value: "paid", text: "Paid" });
    this.modelFilter.addEventListener("change", () => this.refreshModelOptions());
    this.modelRefreshButton = this.iconButton(browserRow, "refresh-cw", "Refresh model catalog", () =>
      void this.refreshModelCatalog()
    );

    const modelRow = internal.createDiv();
    this.modelSelect = modelRow.createEl("select", { attr: { "aria-label": "OpenRouter model" } });
    this.favoriteButton = this.iconButton(modelRow, "star", "Favorite model", () => void this.toggleFavorite());
    this.refreshModelOptions();
    this.modelSelect.addEventListener("change", () => void this.selectModel(this.modelSelect.value));
    this.renderModelDetails();
    this.renderPromptContext();
  }

  private renderComposer(): void {
    const composer = this.containerEl.createDiv({ cls: "obsidian-brain-composer" });
    this.commandSuggestionsEl = composer.createDiv({ cls: "obsidian-brain-command-suggestions" });
    const row = composer.createDiv({ cls: "obsidian-brain-composer-row" });
    row.createSpan({ cls: "obsidian-brain-shell-prompt", text: "brain>" });
    this.inputEl = row.createEl("textarea", {
      attr: {
        placeholder: "ask the vault or type /help",
        "aria-label": "Obsidian Brain terminal input",
        rows: "1",
        spellcheck: "true"
      }
    });
    this.sendButton = row.createEl("button", {
      text: "↵",
      cls: "obsidian-brain-run-button",
      attr: { "aria-label": "Run", title: "Run command or send message" }
    });
    this.commandHintEl = composer.createDiv({
      cls: "obsidian-brain-command-hint",
      text: "enter run  ·  tab complete  ·  ↑ history  ·  ctrl+c stop"
    });
    const submit = async () => {
      if (this.folderPickerEl) {
        await this.confirmFolderPicker();
        return;
      }
      if (this.configMenuEl) {
        this.closeConfigMenu();
        return;
      }
      const text = this.inputEl.value.trim();
      if (this.pendingApproval) {
        if (text === "/approve" || text === "/deny") {
          this.inputEl.value = "";
          this.pendingApproval.finish(text === "/approve");
          this.addCommandEcho(text);
          this.hideCommandSuggestions();
        } else {
          this.statusEl.setText("type /approve or /deny");
        }
        return;
      }
      if (this.abortController) {
        this.abortController.abort();
        return;
      }
      if (!text) return;
      this.inputEl.value = "";
      this.rememberInput(text);
      this.hideCommandSuggestions();
      await this.handleInput(text);
    };
    this.sendButton.addEventListener("click", () => void submit());
    this.inputEl.addEventListener("input", () => {
      this.resizeInput();
      this.updateCommandSuggestions();
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (this.folderPickerEl) {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          this.moveFolderSelection(event.key === "ArrowUp" ? -1 : 1);
          return;
        }
        if (event.code === "Space" || event.key === " ") {
          event.preventDefault();
          this.toggleSelectedFolder();
          return;
        }
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          void this.confirmFolderPicker();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          this.closeFolderPicker();
          return;
        }
        event.preventDefault();
        return;
      }
      if (this.configMenuEl) {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          this.moveConfigSelection(event.key === "ArrowUp" ? -1 : 1);
          return;
        }
        if (event.code === "Space" || event.key === " ") {
          event.preventDefault();
          void this.toggleSelectedConfigItem();
          return;
        }
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          this.closeConfigMenu();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          this.closeConfigMenu();
          return;
        }
        event.preventDefault();
        return;
      }
      if (event.ctrlKey && event.key.toLocaleLowerCase() === "c" && this.abortController) {
        event.preventDefault();
        this.abortController.abort();
        return;
      }
      if (event.key === "Tab" && this.visibleSuggestions.length > 0) {
        event.preventDefault();
        this.completeSuggestion();
        return;
      }
      if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey) {
        if (this.visibleSuggestions.length > 0) {
          event.preventDefault();
          this.moveSuggestion(event.key === "ArrowUp" ? -1 : 1);
          return;
        }
        if (!this.inputEl.value.includes("\n")) {
          event.preventDefault();
          this.moveHistory(event.key === "ArrowUp" ? -1 : 1);
          return;
        }
      }
      if (event.key === "Escape") {
        this.hideCommandSuggestions();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void submit();
      }
    });
  }

  private async handleInput(text: string): Promise<void> {
    if (this.abortController) return;
    if (text.startsWith("/")) {
      this.addCommandEcho(text);
      await this.executeCommand(text);
      return;
    }
    this.addMessage("user", text);
    this.messages.push({ role: "user", content: text });
    await this.ensureCurrentChat(text);
    await this.persistCurrentChat();

    await this.plugin.skillRegistry.initialize();
    await this.prepareSkillContext(text);
    this.turnCitations.clear();
    this.abortController = new AbortController();
    this.setGenerating(true);
    try {
      const compacted = await this.plugin.compactChatContext(this.messages, this.abortController.signal);
      if (compacted.compacted) {
        this.messages = compacted.messages;
        await this.persistCurrentChat();
        this.statusEl.setText(compacted.summarizedMessages > 0
          ? `summarized ${compacted.summarizedMessages} messages`
          : "trimmed context");
      }
      await this.runAgentLoop(this.abortController.signal);
    } catch (error) {
      if (this.isAbortError(error)) {
        if (this.activeAssistantBody && this.activePartial) {
          this.activeAssistantBody.setText(`${this.activePartial}\n\n[stopped]`);
          this.messages.push({ role: "assistant", content: this.activePartial });
          await this.persistCurrentChat();
        } else if (this.activeAssistantBody) {
          this.activeAssistantBody.parentElement?.remove();
        } else {
          this.addMessage("assistant", "[operation stopped]");
        }
        this.statusEl.setText("stopped");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        if (this.activeAssistantBody) {
          this.activeAssistantBody.setText(this.activePartial
            ? `${this.activePartial}\n\n[error: ${message}]`
            : `[error: ${message}]`);
        } else {
          this.addMessage("assistant", `[error: ${message}]`);
        }
        this.statusEl.setText("error");
        this.plugin.reportError(error);
      }
    } finally {
      this.activeAssistantBody?.removeClass("obsidian-brain-stream-cursor");
      this.activeAssistantBody = null;
      this.activePartial = "";
      this.abortController = null;
      this.setGenerating(false);
      this.inputEl.focus();
    }
  }

  private async executeCommand(raw: string): Promise<void> {
    const [token = "", ...parts] = commandTokens(raw.trim());
    const command = token.slice(1).toLocaleLowerCase();
    const argument = raw.trim().slice(token.length).trim();

    try {
      switch (command) {
        case "help":
        case "commands":
          await this.listHelp(parts);
          return;
        case "status": {
          const retrieval = this.plugin.retrievalIndex.getStatus();
          const semantic = retrieval.semantic;
          const skills = this.plugin.skillRegistry.list();
          const tasks = this.plugin.taskService.getStatus();
          await this.addTerminalOutput([
            "```text",
            `vault      ${this.app.vault.getName()}`,
            `chat       ${this.currentChat?.title ?? "new / unsaved"}`,
            `model      ${this.plugin.settings.interactiveModel}`,
            `retrieval  ${retrieval.ready ? "ready" : "building"} · ${retrieval.indexedNotes} notes · ${retrieval.chunks} chunks`,
            `lexical    ${retrieval.lexicalProvider}${retrieval.omnisearch.enabled && !retrieval.omnisearch.available ? " · Omnisearch unavailable, fallback active" : ""}`,
            `index load ${retrieval.persistence.skippedForOmnisearch ? "skipped · Omnisearch active" : `${retrieval.persistence.restoredNotes} cached · ${retrieval.persistence.updatedNotes} updated · ${retrieval.persistence.removedNotes} removed`}`,
            `semantic   ${semantic?.enabled ? `${semantic.state} · ${semantic.indexedNotes} notes · ${semantic.indexedChunks} chunks · ${semantic.modelId || "no model"}` : "disabled"}`,
            `scope      ${semantic?.folders.join(", ") || "none"}`,
            `index cost $${(semantic?.estimatedCostUsd ?? 0).toFixed(4)} / $${this.plugin.settings.semanticSpendCapUsd.toFixed(2)} cap`,
            `web        ${this.plugin.settings.useWebSearch ? "enabled · OpenRouter server tool" : "disabled"}`,
            `tasks      ${tasks.active.provider}${tasks.tasknotes.available ? ` · TaskNotes API v${tasks.tasknotes.apiVersion}` : " · Markdown fallback"}`,
            `sensitive  ${retrieval.sensitiveNotes} excluded notes`,
            `skills     ${skills.map((skill) => skill.name).join(", ") || "none"}`,
            `pending    ${this.pendingApproval ? "approval" : "none"}`,
            "```"
          ].join("\n"));
          return;
        }
        case "perf":
          if (parts[0]?.toLocaleLowerCase() === "reset") {
            this.plugin.performance.reset();
            await this.addTerminalOutput("performance measurements reset");
          } else {
            await this.addTerminalOutput(`\`\`\`text\n${this.plugin.performance.report()}\n\`\`\``);
          }
          return;
        case "new":
          this.startNewChat();
          await this.addTerminalOutput("new chat ready");
          return;
        case "chats":
          await this.listChats(parts);
          return;
        case "open":
          await this.openChatCommand(argument);
          return;
        case "rename":
          await this.renameChatCommand(argument);
          return;
        case "delete":
          await this.deleteChatCommand(parts);
          return;
        case "models":
          await this.listModelsCommand(parts);
          return;
        case "model":
          if (MODEL_FILTERS.has(parts[0]?.toLocaleLowerCase() ?? "")) {
            await this.listModelsCommand(parts);
          } else {
            await this.selectModelCommand(argument);
          }
          return;
        case "favorite":
          await this.favoriteModelCommand(argument);
          return;
        case "refresh":
          await this.refreshModelCatalog();
          await this.addTerminalOutput(`model catalog refreshed · ${this.plugin.modelCatalog.length} models`);
          return;
        case "embeddings":
          await this.listEmbeddingModelsCommand(parts);
          return;
        case "embedding":
          await this.selectEmbeddingModelCommand(parts);
          return;
        case "embedding-favorite":
          await this.favoriteEmbeddingModelCommand(argument);
          return;
        case "skills":
          await this.handleSkillCommand("", parts);
          return;
        case "skill":
          await this.handleSkillCommand(argument);
          return;
        case "exp":
          await this.expCommand(parts);
          return;
        case "memory":
          await this.saveMemoryCommand(argument);
          return;
        case "search":
          await this.searchCommand(parts);
          return;
        case "index":
          await this.indexCommand(parts);
          return;
        case "semantic":
          await this.semanticCommand(parts);
          return;
        case "config":
        case "setting":
        case "settings": {
          if (argument.toLocaleLowerCase() !== "native") {
            this.openConfigMenu();
            return;
          }
          const controller = (this.app as App & {
            setting?: { open: () => void; openTabById: (id: string) => void };
          }).setting;
          if (!controller) {
            await this.addTerminalOutput("Obsidian settings are unavailable in this environment", "error");
            return;
          }
          controller.open();
          controller.openTabById(this.plugin.manifest.id);
          return;
        }
        case "clear":
          this.disposeMarkdownComponents();
          this.transcriptEl.empty();
          await this.addTerminalOutput("display cleared · conversation context retained");
          return;
        case "approve":
        case "deny":
          await this.addTerminalOutput("no tool action is awaiting approval", "error");
          return;
        case "stop":
          if (this.abortController) this.abortController.abort();
          else await this.addTerminalOutput("nothing is running");
          return;
        case "":
          await this.addTerminalOutput("type `/help` to list commands");
          return;
        default:
          await this.addTerminalOutput(`unknown command: \`/${command}\`\n\nType \`/help\` to list commands.`, "error");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusEl.setText("error");
      await this.addTerminalOutput(`command failed: ${message}`, "error");
      this.plugin.reportError(error);
    }
  }

  private async listHelp(parts: string[]): Promise<void> {
    const { page, remaining } = readLeadingPage(parts);
    if (remaining.length > 0) {
      await this.addTerminalOutput("usage: `/help [page]`", "error");
      return;
    }
    const paged = paginate(BRAIN_COMMANDS, page);
    if (paged.outOfRange) {
      await this.addPageOutOfRange("command", paged);
      return;
    }
    await this.addTerminalOutput([
      "### commands",
      "",
      ...paged.items.map((item) => `- \`${item.usage}\` — ${item.description}`),
      "",
      this.paginationLine(paged, "commands", (target) => `/help ${target}`)
    ].join("\n"));
  }

  private async listChats(parts: string[]): Promise<void> {
    const { page, remaining } = readLeadingPage(parts);
    const query = remaining.join(" ");
    await this.refreshChatSummaries(false);
    const normalized = query.toLocaleLowerCase();
    const matches = this.chatSummaries
      .filter((chat) => !normalized || `${chat.title} ${chat.path}`.toLocaleLowerCase().includes(normalized));
    const paged = paginate(matches, page);
    this.lastChatResults = paged.items;
    if (matches.length === 0) {
      await this.addTerminalOutput("no saved chats matched");
      return;
    }
    if (paged.outOfRange) {
      await this.addPageOutOfRange("chat", paged);
      return;
    }
    await this.addTerminalOutput([
      "| # | Chat | Updated |",
      "| -: | --- | --- |",
      ...this.lastChatResults.map((chat, index) =>
        `| ${index + 1} | ${this.escapeTable(chat.title)} | ${this.formatDate(chat.updatedAt)} |`
      ),
      "",
      "Open one with `/open <number>`.",
      "",
      this.paginationLine(
        paged,
        "chats",
        (target) => `/chats ${target}${query ? ` ${query}` : ""}`
      )
    ].join("\n"));
  }

  private async openChatCommand(argument: string): Promise<void> {
    if (!argument) {
      await this.addTerminalOutput("usage: `/open <number|title>`", "error");
      return;
    }
    if (this.lastChatResults.length === 0) await this.listChats([]);
    const numeric = Number.parseInt(argument, 10);
    const chat = Number.isInteger(numeric) && String(numeric) === argument
      ? this.lastChatResults[numeric - 1]
      : this.chatSummaries.find((item) =>
        item.title.toLocaleLowerCase().includes(argument.toLocaleLowerCase()) ||
        item.path.toLocaleLowerCase() === argument.toLocaleLowerCase()
      );
    if (!chat) {
      await this.addTerminalOutput(`chat not found: \`${argument}\``, "error");
      return;
    }
    await this.openChat(chat.path);
  }

  private async renameChatCommand(title: string): Promise<void> {
    if (!this.currentChat) {
      await this.addTerminalOutput("there is no saved chat to rename", "error");
      return;
    }
    if (!title) {
      await this.addTerminalOutput("usage: `/rename <title>`", "error");
      return;
    }
    this.currentChat = await this.plugin.chatStore.rename(this.currentChat, title);
    await this.refreshChatSummaries();
    this.renderPromptContext();
    this.statusEl.setText("renamed");
    await this.addTerminalOutput(`renamed chat to **${this.currentChat.title}**`);
  }

  private async deleteChatCommand(parts: string[]): Promise<void> {
    if (!this.currentChat) {
      await this.addTerminalOutput("there is no saved chat to delete", "error");
      return;
    }
    if (!parts.includes("--confirm")) {
      await this.addTerminalOutput(
        `This moves **${this.currentChat.title}** to vault trash.\n\nRun \`/delete --confirm\` to continue.`,
        "warning"
      );
      return;
    }
    const title = this.currentChat.title;
    await this.plugin.chatStore.remove(this.currentChat);
    this.startNewChat();
    await this.refreshChatSummaries();
    await this.addTerminalOutput(`moved **${title}** to vault trash`);
  }

  private async listModelsCommand(parts: string[]): Promise<void> {
    let cursor = 0;
    const requested = parts[cursor]?.toLocaleLowerCase() ?? "";
    const filter = MODEL_FILTERS.has(requested) ? requested : "all";
    if (MODEL_FILTERS.has(requested)) cursor += 1;
    let rankingDays = filter === "popular" ? 30 : 7;
    if ((filter === "popular" || filter === "trending") && /^\d{1,2}d$/i.test(parts[cursor] ?? "")) {
      rankingDays = Number.parseInt(parts[cursor], 10);
      if (![7, 30].includes(rankingDays)) {
        await this.addTerminalOutput("ranking window must be `7d` or `30d`", "error");
        return;
      }
      cursor += 1;
    }
    const pageInput = readLeadingPage(parts.slice(cursor));
    const page = pageInput.page;
    const queryText = pageInput.remaining.join(" ");
    const query = queryText.toLocaleLowerCase();
    const favorites = new Set(this.plugin.settings.favoriteModels);
    if (this.plugin.modelCatalog.length === 0) {
      this.statusEl.setText("loading models…");
      await this.plugin.refreshOpenRouterModels(false);
      this.statusEl.setText("ready");
    }

    let ranked = new Map<string, ModelUsageRanking>();
    let models: OpenRouterModel[];
    if (filter === "popular" || filter === "trending") {
      this.statusEl.setText(`loading ${filter}…`);
      const requestedDays = filter === "trending" ? rankingDays * 2 : rankingDays;
      const range = rankingDateRange(requestedDays);
      const rows = await this.plugin.openRouter.listDailyModelRankings(range.startDate, range.endDate);
      const rankings = filter === "popular"
        ? rankPopularModels(rows)
        : rankTrendingModels(rows, rankingDays);
      const catalogBySlug = new Map<string, OpenRouterModel>();
      for (const model of this.plugin.modelCatalog) {
        catalogBySlug.set(model.id, model);
        if (model.canonical_slug) catalogBySlug.set(model.canonical_slug, model);
      }
      const seen = new Set<string>();
      models = [];
      for (const ranking of rankings) {
        const model = catalogBySlug.get(ranking.modelId);
        if (!model || seen.has(model.id)) continue;
        if (query && !`${model.id} ${model.name ?? ""}`.toLocaleLowerCase().includes(query)) continue;
        seen.add(model.id);
        ranked.set(model.id, ranking);
        models.push(model);
      }
      this.statusEl.setText("ready");
    } else {
      models = this.plugin.modelCatalog.filter((model) => {
        if (query && !`${model.id} ${model.name ?? ""}`.toLocaleLowerCase().includes(query)) return false;
        if (filter === "favorites" && !favorites.has(model.id)) return false;
        if (filter === "free" && !this.isFreeModel(model)) return false;
        if (filter === "paid" && this.isFreeModel(model)) return false;
        return true;
      });
    }

    const paged = paginate(models, page);
    this.lastModelResults = paged.items;
    if (models.length === 0) {
      await this.addTerminalOutput("no models matched · try `/refresh`");
      return;
    }
    if (paged.outOfRange) {
      await this.addPageOutOfRange("model", paged);
      return;
    }

    const rankingHeader = filter === "popular"
      ? `Usage (${rankingDays}d)`
      : `Growth (${rankingDays}d)`;
    const table = filter === "popular" || filter === "trending"
      ? [
          `| # | Rank | Model | ${rankingHeader} | Price | Context |`,
          "| -: | -: | --- | ---: | --- | ---: |",
          ...this.lastModelResults.map((model, index) => {
            const selected = model.id === this.plugin.settings.interactiveModel ? " **← active**" : "";
            const favorite = favorites.has(model.id) ? " ★" : "";
            const context = model.context_length ?? model.top_provider?.context_length ?? 0;
            const ranking = ranked.get(model.id);
            const amount = filter === "popular" ? ranking?.totalTokens ?? 0n : ranking?.growthTokens ?? 0n;
            return `| ${index + 1} | ${paged.offset + index + 1} | \`${model.id}\`${favorite}${selected} | ${filter === "trending" ? "+" : ""}${this.formatTokenCount(amount)} | ${this.isFreeModel(model) ? "free" : "paid"} | ${context ? this.formatNumber(context) : "?"} |`;
          })
        ]
      : [
          "| # | Model | Price | Context |",
          "| -: | --- | --- | ---: |",
          ...this.lastModelResults.map((model, index) => {
            const selected = model.id === this.plugin.settings.interactiveModel ? " **← active**" : "";
            const favorite = favorites.has(model.id) ? " ★" : "";
            const context = model.context_length ?? model.top_provider?.context_length ?? 0;
            return `| ${index + 1} | \`${model.id}\`${favorite}${selected} | ${this.isFreeModel(model) ? "free" : "paid"} | ${context ? this.formatNumber(context) : "?"} |`;
          })
        ];
    const scope = `${filter}${filter === "popular" || filter === "trending" ? ` ${rankingDays}d` : ""}`;
    await this.addTerminalOutput([
      ...table,
      "",
      "Switch with `/model <number>` · toggle favorite with `/favorite <number>`.",
      "",
      this.paginationLine(
        paged,
        "models",
        (target) => `/models ${scope} ${target}${queryText ? ` ${queryText}` : ""}`
      )
    ].join("\n"));
  }

  private resolveModel(argument: string): OpenRouterModel | undefined {
    const numeric = Number.parseInt(argument, 10);
    if (Number.isInteger(numeric) && String(numeric) === argument) return this.lastModelResults[numeric - 1];
    const normalized = argument.toLocaleLowerCase();
    return this.plugin.modelCatalog.find((model) =>
      model.id.toLocaleLowerCase() === normalized ||
      model.name?.toLocaleLowerCase() === normalized
    );
  }

  private async selectModelCommand(argument: string): Promise<void> {
    if (!argument) {
      await this.addTerminalOutput(`active model: \`${this.plugin.settings.interactiveModel}\``);
      return;
    }
    const model = this.resolveModel(argument);
    if (!model) {
      await this.addTerminalOutput(`model not found: \`${argument}\` · use \`/models\` first`, "error");
      return;
    }
    await this.selectModel(model.id);
    await this.addTerminalOutput(`model → \`${model.id}\``);
  }

  private async favoriteModelCommand(argument: string): Promise<void> {
    const model = argument ? this.resolveModel(argument) : this.plugin.getModel();
    if (!model) {
      await this.addTerminalOutput("model not found · use `/models` first", "error");
      return;
    }
    await this.toggleFavorite(model.id);
    const favorite = this.plugin.settings.favoriteModels.includes(model.id);
    await this.addTerminalOutput(`${favorite ? "favorited" : "unfavorited"} \`${model.id}\``);
  }

  private async listEmbeddingModelsCommand(parts: string[]): Promise<void> {
    let cursor = 0;
    const requested = parts[cursor]?.toLocaleLowerCase() ?? "";
    const filter = EMBEDDING_FILTERS.has(requested) ? requested : "all";
    if (EMBEDDING_FILTERS.has(requested)) cursor += 1;
    const pageInput = readLeadingPage(parts.slice(cursor));
    const queryText = pageInput.remaining.join(" ");
    const query = queryText.toLocaleLowerCase();
    if (this.plugin.embeddingModelCatalog.length === 0) {
      this.statusEl.setText("loading embeddings…");
      await this.plugin.refreshEmbeddingModels(false);
      this.statusEl.setText("ready");
    }
    const favorites = new Set(this.plugin.settings.favoriteEmbeddingModels);
    const models = this.plugin.embeddingModelCatalog.filter((model) => {
      if (filter === "favorites" && !favorites.has(model.id)) return false;
      return !query || `${model.id} ${model.name ?? ""} ${model.description ?? ""}`.toLocaleLowerCase().includes(query);
    });
    const paged = paginate(models, pageInput.page);
    this.lastEmbeddingResults = paged.items;
    if (models.length === 0) {
      await this.addTerminalOutput("no embedding models matched");
      return;
    }
    if (paged.outOfRange) {
      await this.addPageOutOfRange("embedding model", paged);
      return;
    }
    await this.addTerminalOutput([
      "| # | Embedding model | Input price / 1M | Context |",
      "| -: | --- | ---: | ---: |",
      ...paged.items.map((model, index) => {
        const active = model.id === this.plugin.settings.embeddingModel ? " **← active**" : "";
        const favorite = favorites.has(model.id) ? " ★" : "";
        const promptPrice = Number.parseFloat(model.pricing?.prompt ?? "");
        const price = Number.isFinite(promptPrice) ? `$${(promptPrice * 1_000_000).toFixed(4)}` : "?";
        return `| ${index + 1} | \`${model.id}\`${favorite}${active} | ${price} | ${model.context_length ? this.formatNumber(model.context_length) : "?"} |`;
      }),
      "",
      "Select with `/embedding <number>` · favorite with `/embedding-favorite <number>`.",
      "",
      this.paginationLine(
        paged,
        "embedding models",
        (target) => `/embeddings ${filter} ${target}${queryText ? ` ${queryText}` : ""}`
      )
    ].join("\n"));
  }

  private resolveEmbeddingModel(argument: string): EmbeddingModel | undefined {
    const numeric = Number.parseInt(argument, 10);
    if (Number.isInteger(numeric) && String(numeric) === argument) return this.lastEmbeddingResults[numeric - 1];
    const normalized = argument.toLocaleLowerCase();
    return this.plugin.embeddingModelCatalog.find((model) =>
      model.id.toLocaleLowerCase() === normalized
      || model.name?.toLocaleLowerCase() === normalized
    );
  }

  private async selectEmbeddingModelCommand(parts: string[]): Promise<void> {
    const argument = parts.find((part) => !part.startsWith("--")) ?? "";
    if (!argument) {
      await this.addTerminalOutput(
        `active embedding model: \`${this.plugin.settings.embeddingModel || "none"}\``
      );
      return;
    }
    if (this.plugin.embeddingModelCatalog.length === 0) await this.plugin.refreshEmbeddingModels(false);
    const model = this.resolveEmbeddingModel(argument);
    if (!model) {
      await this.addTerminalOutput(`embedding model not found: \`${argument}\` · use \`/embeddings\` first`, "error");
      return;
    }
    const changing = Boolean(this.plugin.settings.embeddingModel)
      && this.plugin.settings.embeddingModel !== model.id;
    if (changing && !parts.includes("--confirm")) {
      await this.addTerminalOutput(
        `Changing embedding models clears the semantic index.\n\nRun \`/embedding ${model.id} --confirm\` to continue.`,
        "warning"
      );
      return;
    }
    await this.plugin.selectEmbeddingModel(model.id);
    await this.addTerminalOutput(`embedding model → \`${model.id}\`${changing ? " · semantic rebuild queued" : ""}`);
    if (!this.plugin.settings.semanticSearchEnabled && this.plugin.settings.semanticFolders.length === 0) {
      this.openFolderPicker(true);
    }
  }

  private async favoriteEmbeddingModelCommand(argument: string): Promise<void> {
    const model = argument
      ? this.resolveEmbeddingModel(argument)
      : this.plugin.embeddingModelCatalog.find((item) => item.id === this.plugin.settings.embeddingModel);
    if (!model) {
      await this.addTerminalOutput("embedding model not found · use `/embeddings` first", "error");
      return;
    }
    const favorites = new Set(this.plugin.settings.favoriteEmbeddingModels);
    if (favorites.has(model.id)) favorites.delete(model.id);
    else favorites.add(model.id);
    this.plugin.settings.favoriteEmbeddingModels = [...favorites];
    await this.plugin.saveSettings();
    await this.addTerminalOutput(`${favorites.has(model.id) ? "favorited" : "unfavorited"} \`${model.id}\``);
  }

  private async searchCommand(parts: string[]): Promise<void> {
    const flagStart = parts.findIndex((part) => part.startsWith("--"));
    const queryParts = flagStart < 0 ? parts : parts.slice(0, flagStart);
    const flagParts = flagStart < 0 ? [] : parts.slice(flagStart);
    const query = queryParts.join(" ").trim();
    if (!query) {
      await this.addTerminalOutput(
        "usage: `/search <query> [--mode hybrid|semantic|lexical] [--folder path] [--tag tag] [--property key=value] [--limit n]`",
        "error"
      );
      return;
    }
    let mode: RetrievalMode = "hybrid";
    let limit = 8;
    const folders: string[] = [];
    const tags: string[] = [];
    const properties: Record<string, string> = {};
    for (let index = 0; index < flagParts.length; index += 1) {
      const flag = flagParts[index];
      const value = flagParts[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
      if (flag === "--mode") {
        if (!["hybrid", "semantic", "lexical"].includes(value)) throw new Error("Search mode must be hybrid, semantic, or lexical.");
        mode = value as RetrievalMode;
      } else if (flag === "--folder") folders.push(value);
      else if (flag === "--tag") tags.push(value);
      else if (flag === "--property") {
        const separator = value.indexOf("=");
        if (separator <= 0) throw new Error("Properties use key=value.");
        properties[value.slice(0, separator)] = value.slice(separator + 1);
      } else if (flag === "--limit") {
        limit = Number.parseInt(value, 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Search limit must be from 1 to 20.");
      } else throw new Error(`Unknown search option: ${flag}.`);
      index += 1;
    }
    this.statusEl.setText("searching…");
    const search = await this.plugin.retrievalIndex.search(query, limit, {
      mode,
      folders: folders.length ? folders : undefined,
      tags: tags.length ? tags : undefined,
      properties: Object.keys(properties).length ? properties : undefined
    });
    this.statusEl.setText("ready");
    if (search.results.length === 0) {
      await this.addTerminalOutput(
        `no ${mode} results${search.fallback ? ` · ${search.fallback} fallback active` : ""}`
      );
      return;
    }
    await this.addTerminalOutput([
      "| # | Source | Note | Lines | Excerpt |",
      "| -: | --- | --- | ---: | --- |",
      ...search.results.map((result, index) =>
        `| ${index + 1} | ${(result.sourceEngines ?? [mode]).join("+")} | ${result.citation} | ${result.lineStart}-${result.lineEnd} | ${this.escapeTable(result.excerpt.replace(/\s+/g, " ").slice(0, 240))} |`
      ),
      "",
      [
        `mode: ${search.mode}`,
        search.fallback ? `${search.fallback} fallback` : null,
        search.partial ? "semantic coverage partial" : null
      ].filter(Boolean).join(" · ")
    ].join("\n"));
  }

  private async indexCommand(parts: string[]): Promise<void> {
    const action = parts[0]?.toLocaleLowerCase() || "status";
    const semantic = this.plugin.semanticIndex;
    if (action === "status") {
      await this.addTerminalOutput(this.semanticStatusMarkdown(semantic.getStatus()));
      return;
    }
    if (action === "rebuild" && parts[1]?.toLocaleLowerCase() !== "semantic") {
      this.statusEl.setText("indexing…");
      await this.plugin.rebuildRetrievalIndex();
      this.statusEl.setText("ready");
      await this.addTerminalOutput(`lexical retrieval index rebuilt · ${this.plugin.retrievalIndex.getStatus().indexedNotes} notes`);
      return;
    }
    if (action === "rebuild" && parts[1]?.toLocaleLowerCase() === "semantic") {
      await semantic.start("rebuild", parts.includes("--uncapped"));
      await this.addTerminalOutput(this.semanticStatusMarkdown(semantic.getStatus()));
      return;
    }
    if (action === "pause") semantic.pause();
    else if (action === "resume") await semantic.resume(parts.includes("--uncapped"));
    else if (action === "cancel") semantic.cancel();
    else if (action === "clear") {
      if (parts[1]?.toLocaleLowerCase() !== "semantic" || !parts.includes("--confirm")) {
        await this.addTerminalOutput("Run `/index clear semantic --confirm` to delete the local semantic cache.", "warning");
        return;
      }
      await semantic.clear();
    } else {
      await this.addTerminalOutput(
        "usage: `/index status|rebuild|rebuild semantic [--uncapped]|pause|resume [--uncapped]|cancel|clear semantic --confirm`",
        "error"
      );
      return;
    }
    await this.addTerminalOutput(this.semanticStatusMarkdown(semantic.getStatus()));
  }

  private async semanticCommand(parts: string[]): Promise<void> {
    const action = parts[0]?.toLocaleLowerCase() ?? "";
    if (action === "folders") {
      this.openFolderPicker(false);
      return;
    }
    if (action === "cap") {
      const value = parts[1]?.toLocaleLowerCase();
      const parsed = value === "unlimited" ? 0 : Number.parseFloat(value ?? "");
      if (!Number.isFinite(parsed) || parsed < 0) {
        await this.addTerminalOutput("usage: `/semantic cap <usd|unlimited>`", "error");
        return;
      }
      this.plugin.settings.semanticSpendCapUsd = parsed;
      await this.plugin.saveSettings();
      await this.addTerminalOutput(`semantic spend cap → ${parsed === 0 ? "unlimited" : `$${parsed.toFixed(2)}`}`);
      return;
    }
    await this.addTerminalOutput("usage: `/semantic folders` or `/semantic cap <usd|unlimited>`", "error");
  }

  private semanticStatusMarkdown(status: SemanticIndexStatus): string {
    return [
      "```text",
      `state       ${status.enabled ? status.state : "disabled"}`,
      `model       ${status.modelId || "none"}`,
      `scope       ${status.folders.join(", ") || "none"}`,
      `indexed     ${status.indexedNotes} notes · ${status.indexedChunks} chunks`,
      `progress    ${status.completedChunks} complete · ${status.failedChunks} failed · ${status.queuedNotes} notes queued`,
      `sensitive   ${this.plugin.settings.includeSensitiveSemantic ? "included by global consent" : `${status.skippedSensitiveNotes} skipped`}`,
      `usage       ${this.formatNumber(status.promptTokens)} tokens · $${status.estimatedCostUsd.toFixed(4)} estimated`,
      `coverage    ${status.partial ? "partial" : "complete"}`,
      `error       ${status.lastError ?? "none"}`,
      "```"
    ].join("\n");
  }

  private async expCommand(parts: string[]): Promise<void> {
    const action = parts[0]?.toLocaleLowerCase() ?? "status";
    if (action === "status") {
      const progress = await this.plugin.expService.progress();
      const filled = Math.round(progress.levelProgress / 100);
      const bar = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
      await this.addTerminalOutput([
        "## EXP progress",
        "",
        "| Period | Earned |",
        "| --- | ---: |",
        `| Today | **${progress.today.toLocaleString()} EXP** |`,
        `| Last 7 days | ${progress.last7Days.toLocaleString()} EXP |`,
        `| Last 30 days | ${progress.last30Days.toLocaleString()} EXP |`,
        `| All time | **${progress.total.toLocaleString()} EXP** |`,
        "",
        `Level **${progress.level}** · \`${bar}\` ${progress.levelProgress}/1000 toward level ${progress.level + 1}`,
        "",
        `Current streak: **${progress.currentStreak} day${progress.currentStreak === 1 ? "" : "s"}** · longest: ${progress.longestStreak} · ${progress.awards} award${progress.awards === 1 ? "" : "s"}`,
        "",
        progress.recent.length
          ? `Recent: ${progress.recent.map((entry) => `${entry.value} EXP — ${entry.taskTitle}`).join(" · ")}`
          : "No earned EXP yet. Activate `/skill exp`, then ask Brain to score completed work."
      ].join("\n"));
      return;
    }
    if (action === "history") {
      const { page, remaining } = readLeadingPage(parts.slice(1));
      if (remaining.length > 0) {
        await this.addTerminalOutput("usage: `/exp history [page]`", "error");
        return;
      }
      const history = await this.plugin.expService.history();
      const paged = paginate(history, page);
      if (history.length === 0) {
        await this.addTerminalOutput("no EXP ledger entries yet");
        return;
      }
      if (paged.outOfRange) {
        await this.addPageOutOfRange("EXP event", paged);
        return;
      }
      await this.addTerminalOutput([
        "| When | Action | EXP | Task | Confidence |",
        "| --- | --- | ---: | --- | ---: |",
        ...paged.items.map((entry) =>
          `| ${this.formatDate(entry.recordedAt)} | ${entry.action} | **${entry.value}** | ${this.escapeTable(entry.taskTitle)} | ${Math.round(entry.confidence * 100)}% |`
        ),
        "",
        this.paginationLine(paged, "EXP events", (target) => `/exp history ${target}`)
      ].join("\n"));
      return;
    }
    if (action === "review") {
      const days = parts[1] === undefined ? 30 : Number.parseInt(parts[1], 10);
      if (!Number.isInteger(days) || days < 1 || days > 365 || parts.length > 2) {
        await this.addTerminalOutput("usage: `/exp review [1-365 days]`", "error");
        return;
      }
      const review = await this.plugin.expService.review(days);
      await this.addTerminalOutput([
        `## EXP calibration review · ${review.days} days`,
        "",
        `Awards: **${review.awards}** · average: **${review.average} EXP** · median: **${review.median} EXP** · low-confidence: **${review.lowConfidence}**`,
        "",
        "| Rubric band | Awards |",
        "| --- | ---: |",
        ...review.buckets.map((bucket) => `| ${bucket.label} | ${bucket.count} |`),
        "",
        review.commonScores.length
          ? `Most-used scores: ${review.commonScores.map((score) => `${score.value} (${score.count})`).join(" · ")}`
          : "No earned EXP in this period.",
        "",
        ...review.observations.map((observation) => `- ${observation}`),
        "",
        "Use `/exp calibrate` to activate the EXP rubric before reviewing or scoring tasks."
      ].join("\n"));
      return;
    }
    if (action === "task") {
      const path = parts.slice(1).join(" ");
      if (!path) {
        await this.addTerminalOutput("usage: `/exp task <task-path>`", "error");
        return;
      }
      const exp = await this.plugin.expService.taskState(path);
      if (!exp) {
        await this.addTerminalOutput(`no EXP score is stored on \`${path}\``);
        return;
      }
      await this.addTerminalOutput([
        `## Task EXP · [[${path.replace(/\.md$/i, "")}]]`,
        "",
        `**${exp.value} EXP** · ${exp.state} · ${Math.round(exp.confidence * 100)}% confidence · revision ${exp.revision}`,
        "",
        exp.reason,
        "",
        "| Factor | Assessment |",
        "| --- | --- |",
        ...Object.entries(exp.factors).map(([name, value]) =>
          `| ${name} | ${this.escapeTable(value)} |`
        )
      ].join("\n"));
      return;
    }
    if (action === "calibrate") {
      if (parts.length > 1) {
        await this.addTerminalOutput("usage: `/exp calibrate`", "error");
        return;
      }
      await this.handleSkillCommand("exp");
      await this.addTerminalOutput(
        "EXP calibration mode is ready. Describe completed work or name a TaskNotes task. Brain will inspect it, apply the rubric, propose one score, and show an approval preview before writing the task and Markdown ledger."
      );
      return;
    }
    await this.addTerminalOutput(
      "usage: `/exp [status|history [page]|review [days]|task <path>|calibrate]`",
      "error"
    );
  }

  private async saveMemoryCommand(content: string): Promise<void> {
    if (!content) {
      await this.addTerminalOutput("usage: `/memory <text>`", "error");
      return;
    }
    const file = await this.plugin.saveLowRiskMemory(content, "chat command");
    await this.addTerminalOutput(`saved memory fragment · [[${file.path.replace(/\.md$/, "")}]]`);
  }

  private addCommandEcho(command: string): void {
    this.transcriptEl.querySelector(".obsidian-brain-empty")?.remove();
    const line = this.transcriptEl.createDiv({ cls: "obsidian-brain-command-echo" });
    line.createSpan({ cls: "obsidian-brain-line-prefix", text: "$" });
    line.createSpan({ text: command });
    line.scrollIntoView({ block: "end" });
  }

  private async addTerminalOutput(markdown: string, state: "system" | "warning" | "error" = "system"): Promise<void> {
    this.transcriptEl.querySelector(".obsidian-brain-empty")?.remove();
    const output = this.transcriptEl.createDiv({ cls: `obsidian-brain-terminal-output is-${state}` });
    output.createSpan({ cls: "obsidian-brain-line-prefix", text: state === "error" ? "!" : state === "warning" ? "?" : "›" });
    const body = output.createDiv({ cls: "obsidian-brain-terminal-output-body markdown-rendered obsidian-brain-markdown" });
    await this.renderInlineMarkdown(body, markdown);
    output.scrollIntoView({ block: "end" });
  }

  private getConfigMenuItems(): ConfigMenuItem[] {
    return [
      {
        id: "omnisearch",
        label: "Use Omnisearch for lexical search",
        description: "Reuse Omnisearch ranking while Brain filters excluded and sensitive notes.",
        checked: () => this.plugin.settings.useOmnisearch,
        detail: () => {
          const status = this.plugin.omnisearchProvider.getStatus();
          if (status.active) return "active · installed";
          if (status.enabled) return "enabled · plugin not detected · built-in fallback";
          return status.available ? "disabled · installed" : "disabled · plugin not detected";
        },
        toggle: async () => {
          const previous = this.plugin.settings.useOmnisearch;
          this.plugin.settings.useOmnisearch = !previous;
          try {
            await this.plugin.saveSettings();
            await this.plugin.reconfigureLexicalProvider();
          } catch (error) {
            this.plugin.settings.useOmnisearch = previous;
            throw error;
          }
        }
      },
      {
        id: "web",
        label: "Allow OpenRouter web search",
        description: "Let the model search the live internet through OpenRouter when a request needs current information.",
        checked: () => this.plugin.settings.useWebSearch,
        detail: () => this.plugin.settings.useWebSearch
          ? "enabled · server tool · compatibility retry on 5xx · usage may cost"
          : "disabled",
        toggle: async () => {
          const previous = this.plugin.settings.useWebSearch;
          this.plugin.settings.useWebSearch = !previous;
          try {
            await this.plugin.saveSettings();
          } catch (error) {
            this.plugin.settings.useWebSearch = previous;
            throw error;
          }
        }
      },
      {
        id: "semantic",
        label: "Enable hybrid semantic search",
        description: "Embed selected folders through OpenRouter and fuse semantic results with lexical search.",
        checked: () => this.plugin.settings.semanticSearchEnabled,
        detail: () => {
          const status = this.plugin.semanticIndex.getStatus();
          if (!this.plugin.settings.embeddingModel) return "model required";
          if (this.plugin.settings.semanticFolders.length === 0) return "folder scope required";
          return this.plugin.settings.semanticSearchEnabled
            ? `${status.state} · ${status.indexedChunks} chunks`
            : "disabled";
        },
        toggle: async () => {
          if (this.plugin.settings.semanticSearchEnabled) {
            await this.plugin.setSemanticSearchEnabled(false);
            return;
          }
          if (!this.plugin.settings.embeddingModel) {
            this.closeConfigMenu();
            await this.listEmbeddingModelsCommand([]);
            await this.addTerminalOutput("Choose one with `/embedding <number|id>`. Folder selection will follow.");
            return;
          }
          if (this.plugin.settings.semanticFolders.length === 0) {
            this.closeConfigMenu(false);
            this.openFolderPicker(true);
            return;
          }
          await this.plugin.setSemanticSearchEnabled(true);
        }
      },
      {
        id: "sensitive-semantic",
        label: "Include sensitive notes in semantic search",
        description: "Global consent to send sensitive chunks for embedding and retrieve them without per-search approval.",
        checked: () => this.plugin.settings.includeSensitiveSemantic,
        detail: () => this.sensitiveConsentPending
          ? "press Space again to confirm both disclosures"
          : this.plugin.settings.includeSensitiveSemantic ? "enabled · global consent active" : "disabled · two-step confirmation",
        toggle: async () => {
          if (this.plugin.settings.includeSensitiveSemantic) {
            this.sensitiveConsentPending = false;
            await this.plugin.setSensitiveSemanticEnabled(false);
            return;
          }
          if (!this.sensitiveConsentPending) {
            this.sensitiveConsentPending = true;
            return;
          }
          this.sensitiveConsentPending = false;
          await this.plugin.setSensitiveSemanticEnabled(true);
        }
      }
    ];
  }

  private openConfigMenu(): void {
    if (this.configMenuEl) return;
    this.transcriptEl.querySelector(".obsidian-brain-empty")?.remove();
    const output = this.transcriptEl.createDiv({
      cls: "obsidian-brain-terminal-output obsidian-brain-config-output is-system"
    });
    output.createSpan({ cls: "obsidian-brain-line-prefix", text: "›" });
    this.configMenuEl = output.createDiv({
      cls: "obsidian-brain-terminal-output-body obsidian-brain-config-menu"
    });
    this.configMenuSelection = 0;
    this.inputEl.value = "";
    this.inputEl.readOnly = true;
    this.inputEl.placeholder = "config menu active";
    this.commandHintEl.setText("↑/↓ select  ·  space toggle  ·  enter leave");
    this.statusEl.setText("config");
    this.hideCommandSuggestions();
    this.renderConfigMenu();
    output.scrollIntoView({ block: "end" });
    this.inputEl.focus();
  }

  private renderConfigMenu(): void {
    if (!this.configMenuEl) return;
    const items = this.getConfigMenuItems();
    this.configMenuSelection = Math.max(0, Math.min(this.configMenuSelection, items.length - 1));
    this.configMenuEl.empty();
    this.configMenuEl.createDiv({ cls: "obsidian-brain-config-title", text: "config" });
    this.configMenuEl.createDiv({ cls: "obsidian-brain-config-section", text: "retrieval" });
    items.forEach((item, index) => {
      const row = this.configMenuEl!.createDiv({
        cls: `obsidian-brain-config-item${index === this.configMenuSelection ? " is-selected" : ""}`,
        attr: {
          role: "checkbox",
          "aria-checked": String(item.checked()),
          "aria-label": item.label
        }
      });
      row.createSpan({ cls: "obsidian-brain-config-cursor", text: index === this.configMenuSelection ? ">" : " " });
      row.createSpan({ cls: "obsidian-brain-config-checkbox", text: item.checked() ? "[x]" : "[ ]" });
      const copy = row.createDiv({ cls: "obsidian-brain-config-copy" });
      copy.createDiv({ cls: "obsidian-brain-config-label", text: item.label });
      copy.createDiv({ cls: "obsidian-brain-config-description", text: item.description });
      row.createSpan({ cls: "obsidian-brain-config-detail", text: item.detail() });
      row.addEventListener("mouseenter", () => {
        if (this.configMenuSelection === index) return;
        this.configMenuSelection = index;
        this.renderConfigMenu();
      });
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.configMenuSelection = index;
        void this.toggleSelectedConfigItem();
      });
    });
    this.configMenuEl.createDiv({
      cls: "obsidian-brain-config-footer",
      text: this.configMenuBusy ? "saving…" : "space toggle · enter leave"
    });
  }

  private moveConfigSelection(direction: number): void {
    const itemCount = this.getConfigMenuItems().length;
    if (itemCount === 0) return;
    this.configMenuSelection = (this.configMenuSelection + direction + itemCount) % itemCount;
    this.renderConfigMenu();
  }

  private async toggleSelectedConfigItem(): Promise<void> {
    if (!this.configMenuEl || this.configMenuBusy) return;
    const item = this.getConfigMenuItems()[this.configMenuSelection];
    if (!item) return;
    this.configMenuBusy = true;
    this.renderConfigMenu();
    try {
      await item.toggle();
      this.statusEl.setText(item.checked() ? `${item.id} enabled` : `${item.id} disabled`);
    } catch (error) {
      this.plugin.reportError(error);
      this.statusEl.setText("config error");
    } finally {
      this.configMenuBusy = false;
      this.renderConfigMenu();
    }
  }

  private closeConfigMenu(showClosedState = true): void {
    if (!this.configMenuEl) return;
    const menu = this.configMenuEl;
    this.configMenuEl = null;
    this.configMenuBusy = false;
    if (showClosedState) {
      menu.empty();
      menu.createDiv({ cls: "obsidian-brain-config-closed", text: "config saved · menu closed" });
    } else {
      menu.parentElement?.remove();
    }
    this.inputEl.readOnly = false;
    this.inputEl.placeholder = "ask the vault or type /help";
    this.commandHintEl.setText("enter run  ·  tab complete  ·  ↑ history  ·  ctrl+c stop");
    this.statusEl.setText("ready");
    this.inputEl.focus();
  }

  private openFolderPicker(enableAfterConfirm: boolean): void {
    if (this.folderPickerEl) return;
    this.closeConfigMenu(false);
    this.transcriptEl.querySelector(".obsidian-brain-empty")?.remove();
    const output = this.transcriptEl.createDiv({
      cls: "obsidian-brain-terminal-output obsidian-brain-config-output is-system"
    });
    output.createSpan({ cls: "obsidian-brain-line-prefix", text: "›" });
    this.folderPickerEl = output.createDiv({
      cls: "obsidian-brain-terminal-output-body obsidian-brain-config-menu"
    });
    this.folderPickerFolders = ["/", ...this.app.vault.getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => folder.path)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))];
    this.folderPickerSelected = new Set(this.plugin.settings.semanticFolders);
    this.folderPickerSelection = 0;
    this.folderPickerEnableAfterConfirm = enableAfterConfirm;
    this.inputEl.value = "";
    this.inputEl.readOnly = true;
    this.inputEl.placeholder = "semantic folder picker active";
    this.commandHintEl.setText("↑/↓ select  ·  space toggle  ·  enter save  ·  esc cancel");
    this.statusEl.setText("folder scope");
    this.hideCommandSuggestions();
    this.renderFolderPicker();
    output.scrollIntoView({ block: "end" });
    this.inputEl.focus();
  }

  private renderFolderPicker(): void {
    if (!this.folderPickerEl) return;
    this.folderPickerEl.empty();
    this.folderPickerEl.createDiv({ cls: "obsidian-brain-config-title", text: "semantic folders" });
    this.folderPickerEl.createDiv({
      cls: "obsidian-brain-config-section",
      text: "selected folders include all descendants"
    });
    if (this.folderPickerFolders.length === 0) {
      this.folderPickerEl.createDiv({ cls: "obsidian-brain-config-closed", text: "no vault folders found" });
    }
    this.folderPickerFolders.forEach((folder, index) => {
      const depth = folder === "/" ? 0 : folder.split("/").length - 1;
      const row = this.folderPickerEl!.createDiv({
        cls: `obsidian-brain-config-item${index === this.folderPickerSelection ? " is-selected" : ""}`,
        attr: {
          role: "checkbox",
          "aria-checked": String(this.folderPickerSelected.has(folder)),
          "aria-label": folder
        }
      });
      row.createSpan({ cls: "obsidian-brain-config-cursor", text: index === this.folderPickerSelection ? ">" : " " });
      row.createSpan({
        cls: "obsidian-brain-config-checkbox",
        text: this.folderPickerSelected.has(folder) ? "[x]" : "[ ]"
      });
      row.createDiv({
        cls: "obsidian-brain-config-label",
        text: folder === "/" ? "(vault root)" : `${"  ".repeat(depth)}${folder.split("/").at(-1) ?? folder}`
      });
      row.createSpan({ cls: "obsidian-brain-config-detail", text: folder });
      row.addEventListener("mouseenter", () => {
        this.folderPickerSelection = index;
        this.renderFolderPicker();
      });
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.folderPickerSelection = index;
        this.toggleSelectedFolder();
      });
    });
    this.folderPickerEl.createDiv({
      cls: "obsidian-brain-config-footer",
      text: `${this.folderPickerSelected.size} selected · space toggle · enter save`
    });
  }

  private moveFolderSelection(direction: number): void {
    if (this.folderPickerFolders.length === 0) return;
    this.folderPickerSelection = (
      this.folderPickerSelection + direction + this.folderPickerFolders.length
    ) % this.folderPickerFolders.length;
    this.renderFolderPicker();
  }

  private toggleSelectedFolder(): void {
    const folder = this.folderPickerFolders[this.folderPickerSelection];
    if (!folder) return;
    if (this.folderPickerSelected.has(folder)) this.folderPickerSelected.delete(folder);
    else this.folderPickerSelected.add(folder);
    this.renderFolderPicker();
  }

  private async confirmFolderPicker(): Promise<void> {
    if (!this.folderPickerEl) return;
    if (this.folderPickerSelected.size === 0) {
      this.statusEl.setText("select at least one folder");
      return;
    }
    const selected = (this.folderPickerSelected.has("/")
      ? ["/"]
      : [...this.folderPickerSelected].filter((folder) =>
      ![...this.folderPickerSelected].some((candidate) =>
        candidate !== folder && folder.startsWith(`${candidate}/`)
      )
    )).sort((left, right) => left.localeCompare(right));
    const enable = this.folderPickerEnableAfterConfirm;
    this.plugin.settings.semanticFolders = selected;
    await this.plugin.saveSettings();
    this.closeFolderPicker();
    if (enable) await this.plugin.setSemanticSearchEnabled(true);
    else if (this.plugin.settings.semanticSearchEnabled) {
      void this.plugin.semanticIndex.reconfigure().catch((error) => this.plugin.reportError(error));
    }
    await this.addTerminalOutput(`semantic scope → ${selected.map((folder) => `\`${folder}\``).join(", ")}`);
  }

  private closeFolderPicker(showClosedState = true): void {
    if (!this.folderPickerEl) return;
    const picker = this.folderPickerEl;
    this.folderPickerEl = null;
    if (showClosedState) {
      picker.empty();
      picker.createDiv({ cls: "obsidian-brain-config-closed", text: "folder picker closed" });
    } else picker.parentElement?.remove();
    this.inputEl.readOnly = false;
    this.inputEl.placeholder = "ask the vault or type /help";
    this.commandHintEl.setText("enter run  ·  tab complete  ·  ↑ history  ·  ctrl+c stop");
    this.statusEl.setText("ready");
    this.inputEl.focus();
  }

  private renderSemanticStatus(status: SemanticIndexStatus): void {
    if (!this.statusEl) return;
    if (status.state === "running") {
      this.statusEl.setText(`embedding ${status.completedChunks} · ${status.queuedNotes} notes`);
    } else if (status.state === "paused") {
      this.statusEl.setText("semantic paused");
    } else if (status.state === "error") {
      this.statusEl.setText("semantic error");
    }
    const shouldRender = status.state === "running"
      || status.state === "paused"
      || status.state === "cancelled"
      || status.state === "error"
      || Boolean(this.semanticProgressEl && status.completedChunks > 0);
    if (!shouldRender || !this.transcriptEl) return;
    if (!this.semanticProgressEl) {
      this.transcriptEl.querySelector(".obsidian-brain-empty")?.remove();
      const output = this.transcriptEl.createDiv({
        cls: "obsidian-brain-terminal-output obsidian-brain-semantic-progress is-system"
      });
      output.createSpan({ cls: "obsidian-brain-line-prefix", text: "↻" });
      this.semanticProgressEl = output.createEl("pre", {
        cls: "obsidian-brain-terminal-output-body obsidian-brain-progress-body"
      });
      output.scrollIntoView({ block: "end" });
    }
    this.semanticProgressEl.setText([
      `semantic ${status.state}`,
      `model     ${status.modelId || "none"}`,
      `scope     ${status.folders.join(", ") || "none"}`,
      `progress  ${status.completedChunks} chunks · ${status.failedChunks} failed · ${status.queuedNotes} notes queued`,
      `stored    ${status.indexedNotes} notes · ${status.indexedChunks} chunks`,
      `usage     ${this.formatNumber(status.promptTokens)} tokens · $${status.estimatedCostUsd.toFixed(4)}`,
      status.lastError ? `error     ${status.lastError}` : ""
    ].filter(Boolean).join("\n"));
  }

  private escapeTable(value: string): string {
    return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  }

  private paginationLine<T>(
    paged: Page<T>,
    label: string,
    commandForPage: (page: number) => string
  ): string {
    const navigation: string[] = [];
    if (paged.hasPrevious) navigation.push(`previous: \`${commandForPage(paged.page - 1)}\``);
    if (paged.hasNext) navigation.push(`next: \`${commandForPage(paged.page + 1)}\``);
    return `Page ${paged.page}/${paged.totalPages} · ${paged.totalItems} ${label}${navigation.length ? ` · ${navigation.join(" · ")}` : ""}`;
  }

  private async addPageOutOfRange<T>(label: string, paged: Page<T>): Promise<void> {
    await this.addTerminalOutput(
      `page ${paged.page} is out of range · ${paged.totalItems} ${label}${paged.totalItems === 1 ? "" : "s"} · last page is ${paged.totalPages}`,
      "error"
    );
  }

  private formatTokenCount(value: bigint): string {
    const units = [
      { threshold: 1_000_000_000_000_000n, suffix: "Q" },
      { threshold: 1_000_000_000_000n, suffix: "T" },
      { threshold: 1_000_000_000n, suffix: "B" },
      { threshold: 1_000_000n, suffix: "M" },
      { threshold: 1_000n, suffix: "K" }
    ];
    for (const unit of units) {
      if (value < unit.threshold) continue;
      const tenths = value * 10n / unit.threshold;
      return tenths % 10n === 0n
        ? `${tenths / 10n}${unit.suffix}`
        : `${tenths / 10n}.${tenths % 10n}${unit.suffix}`;
    }
    return value.toString();
  }

  private formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  private async runAgentLoop(signal: AbortSignal): Promise<void> {
    const maxIterations = 8;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (signal.aborted) throw new DOMException("Generation stopped.", "AbortError");

      const assistantBody = this.addMessage("assistant", "");
      this.activeAssistantBody = assistantBody;
      this.activePartial = "";
      assistantBody.addClass("obsidian-brain-stream-cursor");
      this.statusEl.setText(iteration === 0 ? "thinking…" : "using tools…");

      const result = await this.plugin.streamChatCompletion(
        this.messages,
        (delta) => {
          this.activePartial += delta;
          assistantBody.setText(this.activePartial);
          assistantBody.scrollIntoView({ block: "end" });
        },
        signal
      );
      assistantBody.removeClass("obsidian-brain-stream-cursor");

      let completed = result.content || this.activePartial;
      if (result.toolCalls.length === 0 && completed && this.turnCitations.size > 0) {
        const missing = [...this.turnCitations].filter((citation) => !completed.includes(citation));
        if (missing.length > 0) completed = `${completed}\n\n**Sources:** ${missing.join(" · ")}`;
      }
      this.messages.push({
        role: "assistant",
        content: completed || null,
        ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {})
      });
      await this.persistCurrentChat();

      if (completed) {
        assistantBody.setText(completed);
        await this.renderAssistantMarkdown(assistantBody, completed);
      }
      else assistantBody.parentElement?.remove();
      this.activeAssistantBody = null;
      this.activePartial = "";

      if (result.toolCalls.length === 0) {
        if (!completed) throw new Error("OpenRouter completed without returning text or requesting a tool.");
        this.statusEl.setText(result.finishReason ? `ready · ${result.finishReason}` : "ready");
        return;
      }

      for (const call of result.toolCalls) {
        if (signal.aborted) throw new DOMException("Generation stopped.", "AbortError");
        const toolResult = await this.handleToolCall(call, signal);
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: this.serializeToolResult(toolResult)
        });
        await this.persistCurrentChat();
      }
    }
    throw new Error(`The agent exceeded ${maxIterations} tool iterations.`);
  }

  private async handleToolCall(call: ToolCall, signal: AbortSignal): Promise<unknown> {
    const risk = this.plugin.agentTools.riskFor(call.function.name);
    const card = this.addToolCard(call, risk);
    if (!risk) {
      card.setStatus("unknown tool", "error");
      return { ok: false, error: `Unknown tool: ${call.function.name}` };
    }
    let inspection;
    try {
      inspection = await this.plugin.agentTools.inspect(call);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      card.setStatus(message, "error");
      return { ok: false, error: message };
    }
    if (inspection.preview) card.setPreview(inspection.preview);
    if (inspection.sensitive) {
      card.setSensitive(inspection.sensitivityReasons);
    }

    const needsApproval = requiresApproval(risk) || inspection.sensitive;
    if (needsApproval) {
      card.setStatus(inspection.sensitive ? "sensitive approval required" : "approval required", "pending");
      const approved = await card.requestApproval(signal);
      if (signal.aborted) throw new DOMException("Operation stopped.", "AbortError");
      if (!approved) {
        card.setStatus("denied", "error");
        return {
          ok: false,
          error: inspection.sensitive
            ? "The user denied access to sensitive note content."
            : "The user denied this write action."
        };
      }
    }

    card.setStatus("running", "pending");
    const result = await this.plugin.agentTools.execute(call, { allowSensitive: inspection.sensitive });
    card.setStatus(result.ok ? "completed" : result.error ?? "failed", result.ok ? "success" : "error");
    if (result.ok) {
      const citations = this.collectCitations(result.result);
      citations.forEach((citation) => this.turnCitations.add(citation));
      card.setSources(citations);
    }
    return result;
  }

  private addToolCard(call: ToolCall, risk: ToolRisk | null): {
    setStatus: (text: string, state: "pending" | "success" | "error") => void;
    setPreview: (preview: ToolPreview) => void;
    setSensitive: (reasons: string[]) => void;
    setSources: (citations: string[]) => void;
    requestApproval: (signal: AbortSignal) => Promise<boolean>;
  } {
    this.transcriptEl.querySelector(".obsidian-brain-empty")?.remove();
    const card = this.transcriptEl.createDiv({ cls: "obsidian-brain-tool" });
    const header = card.createDiv({ cls: "obsidian-brain-tool-header" });
    header.createSpan({ cls: "obsidian-brain-tool-name", text: call.function.name || "unknown tool" });
    header.createSpan({
      cls: "obsidian-brain-tool-risk",
      text: risk === "read" ? "read" : risk ? "write" : "unknown"
    });
    const status = header.createSpan({ cls: "obsidian-brain-tool-status", text: "requested" });
    const details = card.createEl("details", { cls: "obsidian-brain-tool-details" });
    details.createEl("summary", { text: "Arguments" });
    const argumentsEl = details.createEl("pre");
    try {
      argumentsEl.setText(JSON.stringify(this.plugin.agentTools.parseArguments(call), null, 2));
    } catch {
      argumentsEl.setText(call.function.arguments);
    }
    const previewEl = card.createDiv({ cls: "obsidian-brain-tool-preview" });
    const sourcesEl = card.createDiv({ cls: "obsidian-brain-tool-sources" });
    const actions = card.createDiv({ cls: "obsidian-brain-tool-actions" });
    card.scrollIntoView({ block: "end" });

    return {
      setStatus: (text, state) => {
        status.setText(text);
        status.dataset.state = state;
      },
      setPreview: (preview) => {
        previewEl.empty();
        previewEl.createDiv({ cls: "obsidian-brain-tool-preview-title", text: preview.title });
        if (preview.details) previewEl.createEl("pre", { text: preview.details });
        if (preview.before !== undefined || preview.after !== undefined) {
          const diff = previewEl.createDiv({ cls: "obsidian-brain-diff" });
          const before = diff.createDiv({ cls: "obsidian-brain-diff-pane is-before" });
          before.createDiv({ cls: "obsidian-brain-diff-label", text: "Before" });
          before.createEl("pre", { text: preview.before ?? "" });
          const after = diff.createDiv({ cls: "obsidian-brain-diff-pane is-after" });
          after.createDiv({ cls: "obsidian-brain-diff-label", text: "After" });
          after.createEl("pre", { text: preview.after ?? "" });
        }
      },
      setSensitive: (reasons) => {
        card.addClass("is-sensitive");
        const warning = previewEl.createDiv({ cls: "obsidian-brain-sensitive-warning" });
        warning.createEl("strong", { text: "Sensitive note content" });
        warning.createDiv({ text: reasons.join(" · ") });
      },
      setSources: (citations) => {
        if (citations.length === 0) return;
        sourcesEl.empty();
        sourcesEl.createSpan({ text: "Sources: " });
        const links = sourcesEl.createSpan();
        void this.renderInlineMarkdown(links, [...new Set(citations)].join(" · "));
      },
      requestApproval: (signal) => new Promise<boolean>((resolve) => {
        const approve = actions.createEl("button", { text: "/approve", cls: "mod-cta" });
        const deny = actions.createEl("button", { text: "/deny" });
        let settled = false;
        const finish = (approved: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (this.pendingApproval?.finish === finish) this.pendingApproval = null;
          actions.empty();
          this.inputEl.value = "";
          this.inputEl.placeholder = "ask the vault or type /help";
          this.inputEl.disabled = Boolean(this.abortController);
          this.commandHintEl.setText("enter run  ·  tab complete  ·  ↑ history  ·  ctrl+c stop");
          this.sendButton.setText(this.abortController ? "^C" : "↵");
          resolve(approved);
        };
        const onAbort = () => finish(false);
        approve.addEventListener("click", () => finish(true));
        deny.addEventListener("click", () => finish(false));
        this.pendingApproval = { finish };
        this.inputEl.disabled = false;
        this.inputEl.placeholder = "/approve or /deny";
        this.commandHintEl.setText("approval pending  ·  type /approve or /deny");
        this.sendButton.setText("↵");
        this.statusEl.setText("approval");
        this.inputEl.focus();
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) finish(false);
      })
    };
  }

  private async ensureCurrentChat(firstMessage: string): Promise<void> {
    if (this.currentChat) return;
    await this.plugin.ensureDataLayout();
    this.currentChat = await this.plugin.chatStore.create(
      titleFromMessage(firstMessage),
      this.plugin.settings.interactiveModel,
      this.messages
    );
    await this.refreshChatSummaries();
  }

  private async handleSkillCommand(name: string, listParts: string[] = []): Promise<void> {
    await this.plugin.skillRegistry.initialize();
    if (!name) {
      const { page, remaining } = readLeadingPage(listParts);
      if (remaining.length > 0) {
        await this.addTerminalOutput("usage: `/skills [page]`", "error");
        return;
      }
      const skills = this.plugin.skillRegistry.list();
      const paged = paginate(skills, page);
      if (paged.outOfRange) {
        await this.addPageOutOfRange("skill", paged);
        return;
      }
      const response = skills.length > 0
        ? [
            "## Installed skills",
            "",
            ...paged.items.map((skill) => `- **${skill.name}** — ${skill.description}`),
            "",
            this.paginationLine(paged, "skills", (target) => `/skills ${target}`)
          ].join("\n")
        : "No `SKILL.md` skills are installed.";
      await this.addTerminalOutput(response);
      return;
    }
    try {
      const activated = await this.activateSkill(name, false);
      const response = activated
        ? `Activated the **${name}** skill for this conversation.`
        : `The **${name}** skill is already active.`;
      await this.persistCurrentChat();
      await this.addTerminalOutput(response);
    } catch (error) {
      const response = error instanceof Error ? error.message : String(error);
      await this.addTerminalOutput(`skill error: ${response}`, "error");
    }
  }

  private async prepareSkillContext(userText: string): Promise<void> {
    this.refreshBaseSystemMessage();
    await this.plugin.skillRegistry.refresh();
    const catalogMarker = "[Available skills]";
    this.messages = this.messages.filter((message) =>
      !(message.role === "system" && message.content.startsWith(catalogMarker))
    );
    this.messages.splice(1, 0, {
      role: "system",
      content: `${catalogMarker}\n${this.plugin.skillRegistry.catalogPrompt()}\nUse load_skill only when a skill applies. Follow an active skill's instructions and load its references only when directed.`
    });
    const matched = this.plugin.skillRegistry.match(userText);
    if (matched) await this.activateSkill(matched.name, true);
    await this.persistCurrentChat();
  }

  private async activateSkill(name: string, automatic: boolean): Promise<boolean> {
    const marker = `[Active skill: ${name.toLocaleLowerCase()}]`;
    const skill = await this.plugin.skillRegistry.load(name);
    const content = `${marker}\n${skill.instructions}`;
    const activeIndex = this.messages.findIndex((message) =>
      message.role === "system" && message.content.startsWith(marker)
    );
    if (activeIndex >= 0) {
      if (this.messages[activeIndex].content === content) return false;
      this.messages[activeIndex] = { role: "system", content };
    }
    const firstConversationMessage = this.messages.findIndex((message) => message.role !== "system");
    if (activeIndex < 0) {
      this.messages.splice(firstConversationMessage < 0 ? this.messages.length : firstConversationMessage, 0, {
        role: "system",
        content
      });
    }
    const event = this.transcriptEl.createDiv({ cls: "obsidian-brain-skill-event" });
    event.createSpan({
      text: activeIndex >= 0 ? "Refreshed skill: " : automatic ? "Auto-activated skill: " : "Activated skill: "
    });
    event.createEl("strong", { text: skill.metadata.name });
    event.scrollIntoView({ block: "end" });
    return true;
  }

  private async persistCurrentChat(): Promise<void> {
    if (!this.currentChat) return;
    this.currentChat = await this.plugin.chatStore.save({
      ...this.currentChat,
      model: this.plugin.settings.interactiveModel,
      messages: this.messages
    });
    await this.refreshChatSummaries(false);
  }

  private async refreshChatSummaries(updateSelection = true): Promise<void> {
    this.chatSummaries = await this.plugin.chatStore.list();
    this.chatSelect.empty();
    this.chatSelect.createEl("option", {
      value: "",
      text: this.currentChat ? "Select saved chat…" : "New unsaved chat"
    });
    for (const chat of this.chatSummaries) {
      this.chatSelect.createEl("option", {
        value: chat.path,
        text: chat.title
      });
    }
    if (updateSelection && this.currentChat) this.chatSelect.value = this.currentChat.path;
    else if (this.currentChat) this.chatSelect.value = this.currentChat.path;
    this.updateSessionControls();
    this.renderPromptContext();
  }

  private async openChat(path: string): Promise<void> {
    if (this.abortController) return;
    try {
      this.currentChat = await this.plugin.chatStore.load(path);
      this.messages = this.currentChat.messages;
      this.transcriptVisibleStart = null;
      this.refreshBaseSystemMessage();
      this.plugin.settings.interactiveModel = this.currentChat.model;
      await this.plugin.saveSettings();
      await this.renderTranscript();
      this.refreshModelOptions();
      this.renderModelDetails();
      this.chatSelect.value = this.currentChat.path;
      this.updateSessionControls();
      this.statusEl.setText("chat loaded");
      await this.persistCurrentChat();
      this.renderPromptContext();
    } catch (error) {
      this.plugin.reportError(error);
      await this.refreshChatSummaries();
    }
  }

  private startNewChat(): void {
    if (this.abortController) return;
    this.currentChat = null;
    this.messages = [createSystemMessage()];
    this.transcriptVisibleStart = null;
    this.disposeMarkdownComponents();
    this.transcriptEl.empty();
    this.renderEmptyState();
    this.chatSelect.value = "";
    this.updateSessionControls();
    this.statusEl.setText("new chat");
    this.renderPromptContext();
    this.inputEl.focus();
  }

  private refreshBaseSystemMessage(): void {
    const current = createSystemMessage();
    const index = this.messages.findIndex((message) =>
      message.role === "system" &&
      (message.content.startsWith("[Obsidian Brain system") ||
        message.content.startsWith("You are Obsidian Brain"))
    );
    if (index < 0) this.messages.unshift(current);
    else this.messages[index] = current;
  }

  private async renameCurrentChat(): Promise<void> {
    if (!this.currentChat || this.abortController) return;
    const modal = new TextPromptModal(this.app, "Rename chat", this.currentChat.title);
    modal.open();
    const title = await modal.result;
    if (!title || title === this.currentChat.title) return;
    try {
      this.currentChat = await this.plugin.chatStore.rename(this.currentChat, title);
      await this.refreshChatSummaries();
      this.statusEl.setText("renamed");
      this.renderPromptContext();
    } catch (error) {
      this.plugin.reportError(error);
    }
  }

  private async deleteCurrentChat(): Promise<void> {
    if (!this.currentChat || this.abortController) return;
    const modal = new ConfirmModal(
      this.app,
      "Delete chat",
      `Move “${this.currentChat.title}” to the vault trash?`
    );
    modal.open();
    if (!await modal.result) return;
    try {
      await this.plugin.chatStore.remove(this.currentChat);
      new Notice("Obsidian Brain moved the chat to the vault trash.");
      this.startNewChat();
      await this.refreshChatSummaries();
    } catch (error) {
      this.plugin.reportError(error);
    }
  }

  private async renderTranscript(scrollToEnd = true): Promise<void> {
    this.disposeMarkdownComponents();
    this.transcriptEl.empty();
    const visibleIndexes = this.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) =>
        ((message.role === "user" || message.role === "assistant") && Boolean(message.content))
        || (message.role === "assistant" && Boolean(message.tool_calls?.length))
      )
      .map(({ index }) => index);
    if (this.transcriptVisibleStart === null) {
      this.transcriptVisibleStart = Math.max(0, visibleIndexes.length - TRANSCRIPT_INITIAL_MESSAGES);
    } else {
      this.transcriptVisibleStart = Math.min(this.transcriptVisibleStart, visibleIndexes.length);
    }
    const firstMessageIndex = visibleIndexes[this.transcriptVisibleStart] ?? this.messages.length;
    if (this.transcriptVisibleStart > 0) {
      const earlierCount = this.transcriptVisibleStart;
      const loadEarlier = this.transcriptEl.createEl("button", {
        cls: "obsidian-brain-load-earlier",
        text: `↑ load ${Math.min(TRANSCRIPT_PAGE_MESSAGES, earlierCount)} earlier · ${earlierCount} hidden`
      });
      loadEarlier.addEventListener("click", () => {
        const oldHeight = this.transcriptEl.scrollHeight;
        this.transcriptVisibleStart = Math.max(0, (this.transcriptVisibleStart ?? 0) - TRANSCRIPT_PAGE_MESSAGES);
        void this.renderTranscript(false).then(() => {
          this.transcriptEl.scrollTop = Math.max(0, this.transcriptEl.scrollHeight - oldHeight);
        });
      });
    }
    let visible = false;
    for (const [index, message] of this.messages.entries()) {
      if (index < firstMessageIndex) continue;
      if ((message.role === "user" || message.role === "assistant") && message.content) {
        const body = this.addMessage(message.role, message.content);
        if (message.role === "assistant") await this.renderAssistantMarkdown(body, message.content);
        visible = true;
      }
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) {
          const card = this.addToolCard(call, this.plugin.agentTools.riskFor(call.function.name));
          card.setStatus("previously executed", "success");
          visible = true;
        }
      }
    }
    if (!visible) this.renderEmptyState();
    else if (scrollToEnd) this.transcriptEl.lastElementChild?.scrollIntoView({ block: "end" });
  }

  private renderEmptyState(): void {
    const empty = this.transcriptEl.createDiv({ cls: "obsidian-brain-empty" });
    empty.createDiv({ cls: "obsidian-brain-empty-mark", text: "OBSIDIAN_BRAIN" });
    empty.createDiv({ text: "vault agent online" });
    empty.createDiv({ cls: "obsidian-brain-empty-hint", text: "type /help for commands · plain text starts a conversation" });
  }

  private renderPromptContext(): void {
    if (!this.contextChatEl || !this.contextModelEl) return;
    this.contextChatEl.setText(this.currentChat?.title ?? "new");
    this.contextChatEl.title = this.currentChat?.path ?? "Unsaved chat";
    this.contextModelEl.setText(this.plugin.settings.interactiveModel);
    this.contextModelEl.title = this.plugin.settings.interactiveModel;
  }

  private resizeInput(): void {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 160)}px`;
  }

  private rememberInput(text: string): void {
    if (this.commandHistory.at(-1) !== text) this.commandHistory.push(text);
    if (this.commandHistory.length > 100) this.commandHistory.shift();
    this.historyIndex = this.commandHistory.length;
  }

  private moveHistory(direction: number): void {
    if (this.commandHistory.length === 0) return;
    this.historyIndex = Math.max(0, Math.min(this.commandHistory.length, this.historyIndex + direction));
    this.inputEl.value = this.historyIndex === this.commandHistory.length
      ? ""
      : this.commandHistory[this.historyIndex] ?? "";
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
    this.resizeInput();
    this.updateCommandSuggestions();
  }

  private updateCommandSuggestions(): void {
    const value = this.inputEl.value;
    if (!value.startsWith("/") || value.includes("\n") || value.includes(" ")) {
      this.hideCommandSuggestions();
      return;
    }
    const query = value.slice(1).toLocaleLowerCase();
    this.visibleSuggestions = BRAIN_COMMANDS
      .filter((command) => command.name.startsWith(query));
    this.suggestionIndex = Math.min(this.suggestionIndex, Math.max(0, this.visibleSuggestions.length - 1));
    this.renderCommandSuggestions();
  }

  private renderCommandSuggestions(): void {
    this.commandSuggestionsEl.empty();
    if (this.visibleSuggestions.length === 0) {
      this.commandSuggestionsEl.removeClass("is-visible");
      return;
    }
    this.commandSuggestionsEl.addClass("is-visible");
    this.visibleSuggestions.forEach((command, index) => {
      const item = this.commandSuggestionsEl.createDiv({
        cls: `obsidian-brain-command-suggestion${index === this.suggestionIndex ? " is-selected" : ""}`
      });
      item.createEl("code", { text: command.usage });
      item.createSpan({ text: command.description });
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.suggestionIndex = index;
        this.completeSuggestion();
      });
      if (index === this.suggestionIndex) {
        item.scrollIntoView({ block: "nearest" });
      }
    });
  }

  private hideCommandSuggestions(): void {
    this.visibleSuggestions = [];
    this.suggestionIndex = 0;
    if (!this.commandSuggestionsEl) return;
    this.commandSuggestionsEl.empty();
    this.commandSuggestionsEl.removeClass("is-visible");
  }

  private moveSuggestion(direction: number): void {
    if (this.visibleSuggestions.length === 0) return;
    this.suggestionIndex = (
      this.suggestionIndex + direction + this.visibleSuggestions.length
    ) % this.visibleSuggestions.length;
    this.renderCommandSuggestions();
  }

  private completeSuggestion(): void {
    const command = this.visibleSuggestions[this.suggestionIndex];
    if (!command) return;
    this.inputEl.value = `/${command.name}${command.usage.includes(" ") ? " " : ""}`;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
    this.hideCommandSuggestions();
    this.resizeInput();
  }

  private refreshModelOptions(): void {
    const current = this.plugin.settings.interactiveModel;
    const query = this.modelSearch?.value.trim().toLocaleLowerCase() ?? "";
    const filter = this.modelFilter?.value ?? "all";
    const catalog = this.plugin.modelCatalog.filter((model) => {
      const searchable = `${model.name ?? ""} ${model.id}`.toLocaleLowerCase();
      if (query && !searchable.includes(query)) return false;
      if (filter === "favorites" && !this.plugin.settings.favoriteModels.includes(model.id)) return false;
      if (filter === "free" && !this.isFreeModel(model)) return false;
      if (filter === "paid" && this.isFreeModel(model)) return false;
      return true;
    });
    const ids = [...new Set([
      current,
      ...catalog.map((model) => model.id),
      ...(filter === "favorites" ? this.plugin.settings.favoriteModels : [])
    ])];
    this.modelSelect.empty();
    for (const id of ids) {
      const model = this.plugin.getModel(id);
      const label = model?.name && model.name !== id ? `${model.name} — ${id}` : id;
      this.modelSelect.createEl("option", { value: id, text: label });
    }
    this.modelSelect.value = current;
    this.updateFavoriteButton();
  }

  private async selectModel(modelId: string): Promise<void> {
    try {
      this.plugin.settings.interactiveModel = modelId;
      await this.plugin.saveSettings();
      if (this.currentChat) await this.persistCurrentChat();
      this.renderModelDetails();
      this.updateFavoriteButton();
      this.renderPromptContext();
    } catch (error) {
      this.plugin.reportError(error);
    }
  }

  private async toggleFavorite(modelId = this.plugin.settings.interactiveModel): Promise<void> {
    try {
      const favorites = new Set(this.plugin.settings.favoriteModels);
      if (favorites.has(modelId)) favorites.delete(modelId);
      else favorites.add(modelId);
      this.plugin.settings.favoriteModels = [...favorites];
      await this.plugin.saveSettings();
      this.refreshModelOptions();
    } catch (error) {
      this.plugin.reportError(error);
    }
  }

  private renderModelDetails(): void {
    if (!this.modelDetailsEl) return;
    this.modelDetailsEl.empty();
    const model = this.plugin.getModel();
    this.renderPromptContext();
    if (!model) {
      this.modelDetailsEl.setText("· metadata unavailable");
      return;
    }
    const context = model.context_length ?? model.top_provider?.context_length;
    const contextLabel = context ? `${this.formatNumber(context)} context` : "context unknown";
    const inputPrice = this.pricePerMillion(model.pricing?.prompt);
    const outputPrice = this.pricePerMillion(model.pricing?.completion);
    const pricing = this.isFreeModel(model)
      ? "free"
      : `${inputPrice ?? "?"} in / ${outputPrice ?? "?"} out per 1M`;
    const supported = new Set(model.supported_parameters ?? []);
    const modalities = model.architecture?.input_modalities ?? [];
    const toolCapability = supported.size === 0
      ? "tools unknown"
      : supported.has("tools") ? "tools" : "no tools";
    const capabilities = [
      toolCapability,
      modalities.includes("image") ? "vision" : null,
      supported.has("reasoning") ? "reasoning" : null,
      supported.has("structured_outputs") || supported.has("response_format") ? "structured output" : null
    ].filter((value): value is string => Boolean(value));
    this.modelDetailsEl.setText(`· ${contextLabel} · ${pricing} · ${capabilities.join(" · ")}`);
    this.modelDetailsEl.toggleClass("is-tool-incompatible", supported.size > 0 && !supported.has("tools"));
  }

  private async refreshModelCatalog(): Promise<void> {
    this.modelRefreshButton.disabled = true;
    this.modelRefreshButton.addClass("is-loading");
    try {
      await this.plugin.refreshOpenRouterModels();
      this.statusEl.setText(`${this.plugin.modelCatalog.length} models`);
    } catch (error) {
      this.plugin.reportError(error);
    } finally {
      this.modelRefreshButton.removeClass("is-loading");
      this.modelRefreshButton.disabled = Boolean(this.abortController);
    }
  }

  private isFreeModel(model: OpenRouterModel): boolean {
    if (model.id === "openrouter/free" || model.id.endsWith(":free")) return true;
    const prompt = Number(model.pricing?.prompt ?? Number.NaN);
    const completion = Number(model.pricing?.completion ?? Number.NaN);
    return Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
  }

  private pricePerMillion(value?: string): string | null {
    if (value === undefined) return null;
    const price = Number(value);
    if (!Number.isFinite(price)) return null;
    return `$${(price * 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  }

  private formatNumber(value: number): string {
    return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  private updateFavoriteButton(): void {
    if (!this.favoriteButton) return;
    const favorite = this.plugin.settings.favoriteModels.includes(this.plugin.settings.interactiveModel);
    setIcon(this.favoriteButton, favorite ? "star" : "star");
    this.favoriteButton.toggleClass("is-active", favorite);
    this.favoriteButton.setAttribute("aria-pressed", String(favorite));
    this.favoriteButton.setAttribute("aria-label", favorite ? "Remove model from favorites" : "Add model to favorites");
    this.favoriteButton.title = favorite ? "Remove model from favorites" : "Add model to favorites";
  }

  private updateSessionControls(): void {
    const disabled = !this.currentChat || Boolean(this.abortController);
    this.renameChatButton.disabled = disabled;
    this.deleteChatButton.disabled = disabled;
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "clickable-icon obsidian-brain-icon-button",
      attr: { "aria-label": label, title: label }
    });
    setIcon(button, icon);
    button.addEventListener("click", action);
    return button;
  }

  private addMessage(role: "user" | "assistant", text: string): HTMLElement {
    this.transcriptEl.querySelector(".obsidian-brain-empty")?.remove();
    const message = this.transcriptEl.createDiv({ cls: "obsidian-brain-message" });
    message.dataset.role = role;
    message.createDiv({
      cls: "obsidian-brain-message-label",
      text: role === "user" ? "you>" : "brain>"
    });
    const body = message.createDiv({ cls: "obsidian-brain-message-body", text });
    message.scrollIntoView({ block: "end" });
    return body;
  }

  private async renderAssistantMarkdown(body: HTMLElement, markdown: string): Promise<void> {
    body.addClasses(["markdown-rendered", "obsidian-brain-markdown"]);
    await this.renderInlineMarkdown(body, markdown);
  }

  private async renderInlineMarkdown(body: HTMLElement, markdown: string): Promise<void> {
    const previous = this.markdownComponents.get(body);
    if (previous) {
      this.removeChild(previous);
      this.markdownComponents.delete(body);
    }
    body.empty();
    const component = new Component();
    this.addChild(component);
    this.markdownComponents.set(body, component);
    await MarkdownRenderer.render(
      this.app,
      markdown,
      body,
      this.currentChat?.path ?? "",
      component
    );
  }

  private disposeMarkdownComponents(): void {
    for (const component of this.markdownComponents.values()) this.removeChild(component);
    this.markdownComponents.clear();
  }

  private setGenerating(generating: boolean): void {
    this.statusEl.setText(generating ? "generating…" : this.statusEl.getText());
    this.sendButton.setText(generating ? "^C" : "↵");
    this.sendButton.setAttribute("aria-label", generating ? "Stop generation" : "Run");
    this.sendButton.title = generating ? "Stop generation (Ctrl+C)" : "Run command or send message";
    this.sendButton.toggleClass("obsidian-brain-stop", generating);
    this.modelSelect.disabled = generating;
    this.modelSearch.disabled = generating;
    this.modelFilter.disabled = generating;
    this.modelRefreshButton.disabled = generating;
    this.favoriteButton.disabled = generating;
    this.chatSelect.disabled = generating;
    this.newChatButton.disabled = generating;
    this.updateSessionControls();
    this.inputEl.disabled = generating && !this.pendingApproval;
    if (!generating) {
      this.inputEl.placeholder = "ask the vault or type /help";
      this.commandHintEl.setText("enter run  ·  tab complete  ·  ↑ history  ·  ctrl+c stop");
    }
  }

  private serializeToolResult(result: unknown): string {
    const serialized = JSON.stringify(result) ?? "null";
    const limit = 60_000;
    return serialized.length <= limit
      ? serialized
      : `${serialized.slice(0, limit)}\n[Tool result truncated at ${limit.toLocaleString()} characters]`;
  }

  private collectCitations(value: unknown): string[] {
    const citations: string[] = [];
    const visit = (candidate: unknown) => {
      if (Array.isArray(candidate)) {
        candidate.forEach(visit);
        return;
      }
      if (!candidate || typeof candidate !== "object") return;
      for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
        if (key === "citation" && typeof child === "string") citations.push(child);
        else visit(child);
      }
    };
    visit(value);
    return citations;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError";
  }
}
