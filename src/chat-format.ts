import type { ChatMessage } from "./openrouter";

export interface ChatState {
  id: string;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messages: ChatMessage[];
}

export interface ChatSummary {
  id: string;
  title: string;
  path: string;
  updatedAt: string;
  model: string;
}

const STATE_PATTERN = /<!-- (?:brain-cli|obsidian-brain)-state:([A-Za-z0-9+/=]+) -->/;

const bytesToBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const base64ToText = (value: string): string => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
};

export const slugifyChatTitle = (title: string): string => {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "chat";
};

export const titleFromMessage = (message: string): string => {
  const compact = message.replace(/\s+/g, " ").trim();
  if (!compact) return "New chat";
  return compact.length > 60 ? `${compact.slice(0, 57)}…` : compact;
};

export const encodeChatState = (state: ChatState): string =>
  bytesToBase64(JSON.stringify(state));

export const decodeChatState = (markdown: string): ChatState => {
  const encoded = markdown.match(STATE_PATTERN)?.[1];
  if (!encoded) throw new Error("This note does not contain a Brain CLI chat state.");
  const state = JSON.parse(base64ToText(encoded)) as Partial<ChatState>;
  if (
    typeof state.id !== "string"
    || typeof state.title !== "string"
    || typeof state.path !== "string"
    || typeof state.createdAt !== "string"
    || typeof state.updatedAt !== "string"
    || typeof state.model !== "string"
    || !Array.isArray(state.messages)
  ) {
    throw new Error("The stored Brain CLI chat state is invalid.");
  }
  return state as ChatState;
};

const readableMessage = (message: ChatMessage): string | null => {
  if (message.role === "system") return null;
  if (message.role === "tool") {
    return `> Tool result: \`${message.name ?? "tool"}\`\n`;
  }
  const heading = message.role === "user" ? "User" : "Assistant";
  const content = message.content?.trim();
  const toolLines = message.role === "assistant"
    ? (message.tool_calls ?? []).map((call) => `> Tool requested: \`${call.function.name}\``)
    : [];
  if (!content && toolLines.length === 0) return null;
  return [`## ${heading}`, "", content ?? "", ...toolLines, ""].join("\n");
};

export const renderChatMarkdown = (state: ChatState): string => {
  const transcript = state.messages
    .map(readableMessage)
    .filter((message): message is string => Boolean(message))
    .join("\n");
  return [
    "---",
    "type: brain-chat",
    `brain_chat_id: ${JSON.stringify(state.id)}`,
    `title: ${JSON.stringify(state.title)}`,
    `created: ${state.createdAt}`,
    `updated: ${state.updatedAt}`,
    `model: ${JSON.stringify(state.model)}`,
    "---",
    "",
    `# ${state.title}`,
    "",
    `> Model: \`${state.model}\`  `,
    `> Updated: ${state.updatedAt}`,
    "",
    `<!-- brain-cli-state:${encodeChatState(state)} -->`,
    "",
    transcript
  ].join("\n").trimEnd() + "\n";
};
