import {
  ItemView,
  Component,
  MarkdownRenderer,
  Modal,
  Notice,
  Setting,
  setIcon,
  type App,
  type WorkspaceLeaf
} from "obsidian";
import type ObsidianBrainPlugin from "./main";
import type { ChatMessage, ToolCall } from "./openrouter";
import { requiresApproval } from "./permissions";
import type { ToolRisk, OpenRouterModel } from "./types";
import { titleFromMessage, type ChatState, type ChatSummary } from "./chat-format";
import type { ToolPreview } from "./agent-tools";

export const BRAIN_VIEW_TYPE = "obsidian-brain-chat";

const createSystemMessage = (): ChatMessage => ({
  role: "system",
  content: [
    "You are Obsidian Brain, a concise and thoughtful agent operating inside an Obsidian vault.",
    "You have real tools for inspecting the environment and listing, reading, searching, creating, replacing, and updating frontmatter on permitted Markdown notes.",
    "Use tools whenever the answer depends on the vault instead of guessing or merely describing safety.",
    "When asked what you can do or what environment you are in, call get_environment and explain the returned capabilities and limitations plainly.",
    "When vault tools return citations, cite the supporting notes with those exact Obsidian wikilinks.",
    "Read tools run automatically. Every write requires the user's explicit approval in the interface.",
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
  private abortController: AbortController | null = null;
  private activeAssistantBody: HTMLElement | null = null;
  private activePartial = "";
  private messages: ChatMessage[] = [createSystemMessage()];
  private currentChat: ChatState | null = null;
  private chatSummaries: ChatSummary[] = [];
  private readonly markdownComponents = new Map<HTMLElement, Component>();
  private readonly turnCitations = new Set<string>();

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
    this.containerEl.empty();
    this.containerEl.addClass("obsidian-brain-view");
    this.renderHeader();
    this.transcriptEl = this.containerEl.createDiv({ cls: "obsidian-brain-transcript" });
    this.renderEmptyState();
    this.renderComposer();
    await this.refreshChatSummaries();
  }

  async onClose(): Promise<void> {
    this.abortController?.abort();
    this.disposeMarkdownComponents();
  }

  private renderHeader(): void {
    const header = this.containerEl.createDiv({ cls: "obsidian-brain-header" });
    const titleRow = header.createDiv({ cls: "obsidian-brain-title-row" });
    titleRow.createEl("h3", { text: "OBSIDIAN_BRAIN" });
    this.statusEl = titleRow.createSpan({ cls: "obsidian-brain-status", text: "ready" });

    const chatRow = header.createDiv({ cls: "obsidian-brain-session-row" });
    chatRow.createSpan({ cls: "obsidian-brain-prompt-label", text: "chat>" });
    this.chatSelect = chatRow.createEl("select", { attr: { "aria-label": "Saved chat" } });
    this.chatSelect.addEventListener("change", () => {
      if (this.chatSelect.value) void this.openChat(this.chatSelect.value);
    });
    this.newChatButton = this.iconButton(chatRow, "plus", "New chat", () => this.startNewChat());
    this.renameChatButton = this.iconButton(chatRow, "pencil", "Rename chat", () => void this.renameCurrentChat());
    this.deleteChatButton = this.iconButton(chatRow, "trash-2", "Delete chat", () => void this.deleteCurrentChat());

    const browserRow = header.createDiv({ cls: "obsidian-brain-model-browser" });
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

    const modelRow = header.createDiv({ cls: "obsidian-brain-model-row" });
    modelRow.createSpan({ cls: "obsidian-brain-prompt-label", text: "model>" });
    this.modelSelect = modelRow.createEl("select", { attr: { "aria-label": "OpenRouter model" } });
    this.favoriteButton = this.iconButton(modelRow, "star", "Favorite model", () => void this.toggleFavorite());
    this.refreshModelOptions();
    this.modelSelect.addEventListener("change", () => void this.selectModel(this.modelSelect.value));
    this.modelDetailsEl = header.createDiv({ cls: "obsidian-brain-model-details" });
    this.renderModelDetails();
  }

  private renderComposer(): void {
    const composer = this.containerEl.createDiv({ cls: "obsidian-brain-composer" });
    const row = composer.createDiv({ cls: "obsidian-brain-composer-row" });
    this.inputEl = row.createEl("textarea", { attr: { placeholder: "Message the vault brain…" } });
    this.sendButton = row.createEl("button", { text: "Send", cls: "mod-cta" });
    const submit = async () => {
      if (this.abortController) {
        this.abortController.abort();
        return;
      }
      const text = this.inputEl.value.trim();
      if (!text) return;
      this.inputEl.value = "";
      await this.handleInput(text);
    };
    this.sendButton.addEventListener("click", () => void submit());
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void submit();
      }
    });
  }

  private async handleInput(text: string): Promise<void> {
    if (this.abortController) return;
    this.addMessage("user", text);
    this.messages.push({ role: "user", content: text });
    await this.ensureCurrentChat(text);
    await this.persistCurrentChat();

    if (text === "/skill" || text.startsWith("/skill ")) {
      await this.handleSkillCommand(text.slice("/skill".length).trim());
      return;
    }

    if (text.startsWith("/memory ")) {
      const content = text.slice("/memory ".length).trim();
      if (!content) return;
      const file = await this.plugin.saveLowRiskMemory(content, "chat command");
      const response = `Saved a low-risk memory fragment: [[${file.path.replace(/\.md$/, "")}]].`;
      const body = this.addMessage("assistant", response);
      await this.renderAssistantMarkdown(body, response);
      this.messages.push({ role: "assistant", content: response });
      await this.persistCurrentChat();
      return;
    }

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
        const approve = actions.createEl("button", { text: "Approve", cls: "mod-cta" });
        const deny = actions.createEl("button", { text: "Deny" });
        let settled = false;
        const finish = (approved: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          actions.empty();
          resolve(approved);
        };
        const onAbort = () => finish(false);
        approve.addEventListener("click", () => finish(true));
        deny.addEventListener("click", () => finish(false));
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

  private async handleSkillCommand(name: string): Promise<void> {
    await this.plugin.skillRegistry.refresh();
    if (!name) {
      const skills = this.plugin.skillRegistry.list();
      const response = skills.length > 0
        ? `## Installed skills\n\n${skills.map((skill) => `- **${skill.name}** — ${skill.description}`).join("\n")}`
        : "No `SKILL.md` skills are installed.";
      const body = this.addMessage("assistant", response);
      await this.renderAssistantMarkdown(body, response);
      this.messages.push({ role: "assistant", content: response });
      await this.persistCurrentChat();
      return;
    }
    try {
      const activated = await this.activateSkill(name, false);
      const response = activated
        ? `Activated the **${name}** skill for this conversation.`
        : `The **${name}** skill is already active.`;
      const body = this.addMessage("assistant", response);
      await this.renderAssistantMarkdown(body, response);
      this.messages.push({ role: "assistant", content: response });
      await this.persistCurrentChat();
    } catch (error) {
      const response = error instanceof Error ? error.message : String(error);
      const body = this.addMessage("assistant", `Skill error: ${response}`);
      await this.renderAssistantMarkdown(body, `**Skill error:** ${response}`);
      this.messages.push({ role: "assistant", content: `Skill error: ${response}` });
      await this.persistCurrentChat();
    }
  }

  private async prepareSkillContext(userText: string): Promise<void> {
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
    if (this.messages.some((message) =>
      message.role === "system" && message.content.startsWith(marker)
    )) return false;
    const skill = await this.plugin.skillRegistry.load(name);
    const firstConversationMessage = this.messages.findIndex((message) => message.role !== "system");
    this.messages.splice(firstConversationMessage < 0 ? this.messages.length : firstConversationMessage, 0, {
      role: "system",
      content: `${marker}\n${skill.instructions}`
    });
    const event = this.transcriptEl.createDiv({ cls: "obsidian-brain-skill-event" });
    event.createSpan({ text: automatic ? "Auto-activated skill: " : "Activated skill: " });
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
  }

  private async openChat(path: string): Promise<void> {
    if (this.abortController) return;
    try {
      this.currentChat = await this.plugin.chatStore.load(path);
      this.messages = this.currentChat.messages;
      this.plugin.settings.interactiveModel = this.currentChat.model;
      await this.plugin.saveSettings();
      await this.renderTranscript();
      this.refreshModelOptions();
      this.renderModelDetails();
      this.chatSelect.value = this.currentChat.path;
      this.updateSessionControls();
      this.statusEl.setText("chat loaded");
    } catch (error) {
      this.plugin.reportError(error);
      await this.refreshChatSummaries();
    }
  }

  private startNewChat(): void {
    if (this.abortController) return;
    this.currentChat = null;
    this.messages = [createSystemMessage()];
    this.disposeMarkdownComponents();
    this.transcriptEl.empty();
    this.renderEmptyState();
    this.chatSelect.value = "";
    this.updateSessionControls();
    this.statusEl.setText("new chat");
    this.inputEl.focus();
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

  private async renderTranscript(): Promise<void> {
    this.disposeMarkdownComponents();
    this.transcriptEl.empty();
    let visible = false;
    for (const message of this.messages) {
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
    else this.transcriptEl.lastElementChild?.scrollIntoView({ block: "end" });
  }

  private renderEmptyState(): void {
    this.transcriptEl.createDiv({
      cls: "obsidian-brain-empty",
      text: "Vault tools and saved chats are ready.\n\nEnter sends; Shift+Enter adds a new line. Read actions run automatically; writes require approval."
    });
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
    } catch (error) {
      this.plugin.reportError(error);
    }
  }

  private async toggleFavorite(): Promise<void> {
    try {
      const model = this.plugin.settings.interactiveModel;
      const favorites = new Set(this.plugin.settings.favoriteModels);
      if (favorites.has(model)) favorites.delete(model);
      else favorites.add(model);
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
    if (!model) {
      this.modelDetailsEl.setText("Metadata unavailable · refresh the OpenRouter model catalog");
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
    this.modelDetailsEl.setText(`${contextLabel} · ${pricing} · ${capabilities.join(" · ")}`);
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
    message.createDiv({ cls: "obsidian-brain-message-label", text: role });
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
    this.sendButton.setText(generating ? "Stop" : "Send");
    this.sendButton.toggleClass("obsidian-brain-stop", generating);
    this.modelSelect.disabled = generating;
    this.modelSearch.disabled = generating;
    this.modelFilter.disabled = generating;
    this.modelRefreshButton.disabled = generating;
    this.favoriteButton.disabled = generating;
    this.chatSelect.disabled = generating;
    this.newChatButton.disabled = generating;
    this.updateSessionControls();
    this.inputEl.disabled = generating;
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
