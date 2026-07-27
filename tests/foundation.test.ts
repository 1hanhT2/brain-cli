import assert from "node:assert/strict";
import test from "node:test";
import { AgentToolRegistry } from "../src/agent-tools";
import { isVaultPathSafe, requiresApproval } from "../src/permissions";
import type { VaultTools } from "../src/vault-tools";
import {
  decodeChatState,
  renderChatMarkdown,
  slugifyChatTitle,
  titleFromMessage,
  type ChatState
} from "../src/chat-format";
import { compactConversation, estimateMessageTokens } from "../src/context-manager";

const call = (name: string, input: unknown) => ({
  id: `call_${name}`,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(input) }
});

test("vault path policy rejects hidden config, traversal, absolute paths, and URLs", () => {
  assert.equal(isVaultPathSafe("Notes/example.md"), true);
  assert.equal(isVaultPathSafe(".obsidian/plugins/example.md"), false);
  assert.equal(isVaultPathSafe("../outside.md"), false);
  assert.equal(isVaultPathSafe("C:/outside.md"), false);
  assert.equal(isVaultPathSafe("/outside.md"), false);
  assert.equal(isVaultPathSafe("https://example.com/note.md"), false);
});

test("all writes require approval while reads do not", () => {
  assert.equal(requiresApproval("read"), false);
  assert.equal(requiresApproval("low-write"), true);
  assert.equal(requiresApproval("high-write"), true);
  assert.equal(requiresApproval("destructive"), true);
});

test("registry exposes the complete foundational tool surface", () => {
  const registry = new AgentToolRegistry({} as VaultTools);
  assert.deepEqual(
    registry.definitions().map((tool) => tool.function.name),
    [
      "get_environment",
      "list_notes",
      "read_note",
      "search_notes",
      "create_note",
      "replace_note",
      "update_frontmatter"
    ]
  );
  assert.equal(registry.riskFor("read_note"), "read");
  assert.equal(registry.riskFor("create_note"), "high-write");
  assert.equal(registry.riskFor("missing"), null);
});

test("registry executes environment reads and note creation", async () => {
  const vaultTools = {
    getEnvironment: () => ({
      vault: "test-vault",
      activeFile: "Home.md",
      markdownFiles: 12,
      excludedPaths: [".obsidian"]
    }),
    createMarkdown: async (path: string) => ({ path })
  } as VaultTools;
  const registry = new AgentToolRegistry(vaultTools);

  const environment = await registry.execute(call("get_environment", {}));
  assert.equal(environment.ok, true);
  assert.equal((environment.result as { vault: string }).vault, "test-vault");

  const creation = await registry.execute(call("create_note", {
    path: "Notes/new.md",
    content: "# New"
  }));
  assert.deepEqual(creation, {
    ok: true,
    result: { path: "Notes/new.md", created: true }
  });
});

test("registry returns actionable errors for malformed and unknown calls", async () => {
  const registry = new AgentToolRegistry({} as VaultTools);
  const malformed = {
    id: "bad",
    type: "function" as const,
    function: { name: "read_note", arguments: "{" }
  };
  assert.match((await registry.execute(malformed)).error ?? "", /Invalid arguments/);
  assert.match((await registry.execute(call("missing", {}))).error ?? "", /Unknown tool/);
});

test("chat Markdown round-trips Unicode state while remaining readable", () => {
  const state: ChatState = {
    id: "chat-1",
    title: "Đọc Kinh Thánh",
    path: "Brain/Chats/doc-kinh-thanh-chat-1.md",
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-27T10:01:00.000Z",
    model: "openrouter/free",
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: "Đọc 15 trang 📖" },
      { role: "assistant", content: "Đã hiểu." }
    ]
  };
  const markdown = renderChatMarkdown(state);
  assert.match(markdown, /# Đọc Kinh Thánh/);
  assert.match(markdown, /## User/);
  assert.deepEqual(decodeChatState(markdown), state);
});

test("chat titles produce safe filenames and useful defaults", () => {
  assert.equal(slugifyChatTitle("  Hello, World!  "), "hello-world");
  assert.equal(slugifyChatTitle("📖"), "chat");
  assert.equal(titleFromMessage("  Plan   today's work  "), "Plan today's work");
  assert.ok(titleFromMessage("x".repeat(80)).length <= 60);
  assert.ok(titleFromMessage("x".repeat(80)).endsWith("…"));
});

test("context manager summarizes old turns and retains recent turns", async () => {
  const messages = [
    { role: "system" as const, content: "system" },
    ...Array.from({ length: 8 }, (_, index) => ([
      { role: "user" as const, content: `question ${index} ${"x".repeat(3_000)}` },
      { role: "assistant" as const, content: `answer ${index}` }
    ])).flat()
  ];
  assert.ok(estimateMessageTokens(messages) > 4_900);
  const compacted = await compactConversation(messages, 8_192, async () => "Earlier decisions summarized.");
  assert.equal(compacted.compacted, true);
  assert.ok(compacted.summarizedMessages > 0);
  assert.ok(compacted.messages.some((message) =>
    message.role === "system" && message.content.includes("Earlier decisions summarized.")
  ));
  assert.ok(compacted.messages.some((message) =>
    message.role === "user" && message.content.startsWith("question 7")
  ));
});
