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
import { VaultRetrievalIndex } from "../src/retrieval-index";
import type { SkillRegistry } from "../src/skill-registry";
import type { App, TFile } from "obsidian";
import type { SensitiveContentGuard } from "../src/sensitive-content";
import { EXP_AGENT_METADATA, EXP_EXAMPLES, EXP_RUBRIC, EXP_SKILL } from "../src/bundled-exp-skill";
import { ensureFolders } from "../src/folder-layout";

const call = (name: string, input: unknown) => ({
  id: `call_${name}`,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(input) }
});

const makeRegistry = (vaultTools: VaultTools): AgentToolRegistry =>
  new AgentToolRegistry(
    vaultTools,
    {
      getStatus: () => ({ ready: true, indexedNotes: 0, chunks: 0, sensitiveNotes: 0 }),
      search: async () => ({ results: [], indexedNotes: 0, skippedSensitiveNotes: 0 })
    } as VaultRetrievalIndex,
    {
      list: () => [],
      load: async () => { throw new Error("not configured"); },
      readReference: async () => { throw new Error("not configured"); }
    } as SkillRegistry
  );

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

test("Brain layout creation is idempotent while the Vault index is stale", async () => {
  const folders = new Set<string>(["Brain", "Brain/Chats"]);
  const createCalls: string[] = [];
  const adapter = {
    getPathKind: async (path: string) => folders.has(path) ? "folder" as const : null,
    createFolder: async (path: string) => {
      createCalls.push(path);
      folders.add(path);
    }
  };
  const paths = [
    "Brain",
    "Brain/Chats",
    "Brain/Memory",
    "Brain/Calibration",
    "Brain/Settings",
    "Brain/Queue",
    "Brain/Skills"
  ];

  await ensureFolders(adapter, paths);
  await ensureFolders(adapter, paths);

  assert.deepEqual(createCalls, [
    "Brain/Memory",
    "Brain/Calibration",
    "Brain/Settings",
    "Brain/Queue",
    "Brain/Skills"
  ]);
});

test("Brain layout tolerates a concurrent folder creation race", async () => {
  const folders = new Set<string>();
  const adapter = {
    getPathKind: async (path: string) => folders.has(path) ? "folder" as const : null,
    createFolder: async (path: string) => {
      folders.add(path);
      throw new Error("Folder already exists.");
    }
  };

  await ensureFolders(adapter, [
    "Brain",
    "Brain/Chats",
    "Brain/Memory",
    "Brain/Calibration",
    "Brain/Settings",
    "Brain/Queue",
    "Brain/Skills"
  ]);
  assert.equal(folders.size, 7);
});

test("registry exposes the complete foundational tool surface", () => {
  const registry = makeRegistry({} as VaultTools);
  assert.deepEqual(
    registry.definitions().map((tool) => tool.function.name),
    [
      "get_environment",
      "list_notes",
      "read_note",
      "search_notes",
      "retrieve_context",
      "create_note",
      "append_note",
      "apply_note_patch",
      "replace_note",
      "update_frontmatter",
      "rename_note",
      "move_note",
      "trash_note",
      "list_skills",
      "load_skill",
      "read_skill_reference"
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
  const registry = makeRegistry(vaultTools);

  const environment = await registry.execute(call("get_environment", {}));
  assert.equal(environment.ok, true);
  assert.equal((environment.result as { vault: string }).vault, "test-vault");

  const creation = await registry.execute(call("create_note", {
    path: "Notes/new.md",
    content: "# New"
  }));
  assert.deepEqual(creation, {
    ok: true,
    result: { path: "Notes/new.md", citation: "[[Notes/new]]", created: true }
  });
});

test("registry returns actionable errors for malformed and unknown calls", async () => {
  const registry = makeRegistry({} as VaultTools);
  const malformed = {
    id: "bad",
    type: "function" as const,
    function: { name: "read_note", arguments: "{" }
  };
  assert.match((await registry.execute(malformed)).error ?? "", /Invalid arguments/);
  assert.match((await registry.execute(call("missing", {}))).error ?? "", /Unknown tool/);
});

test("tool inspection returns patch diffs and sensitive-read warnings", async () => {
  const registry = makeRegistry({
    previewPatch: async () => ({ before: "old", after: "new", occurrences: 1 }),
    inspectSensitivity: async () => ({ sensitive: true, reasons: ["#private"] })
  } as VaultTools);
  const patch = await registry.inspect(call("apply_note_patch", {
    path: "Note.md",
    old_text: "old",
    new_text: "new"
  }));
  assert.equal(patch.preview?.before, "old");
  assert.equal(patch.preview?.after, "new");
  const read = await registry.inspect(call("read_note", { path: "Private.md" }));
  assert.equal(read.sensitive, true);
  assert.deepEqual(read.sensitivityReasons, ["#private"]);
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
    { role: "system" as const, content: "[Active skill: exp]\nUse the rubric." },
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
    message.role === "system" && message.content.includes("[Active skill: exp]")
  ));
  assert.ok(compacted.messages.some((message) =>
    message.role === "user" && message.content.startsWith("question 7")
  ));
});

test("local retrieval ranks relevant chunks and excludes sensitive notes", async () => {
  const publicFile = { path: "Study/Physics.md", extension: "md" } as TFile;
  const otherFile = { path: "Journal.md", extension: "md" } as TFile;
  const sensitiveFile = { path: "Private.md", extension: "md" } as TFile;
  const contents = new Map<TFile, string>([
    [publicFile, "# Mechanics\nNewtonian force and acceleration determine motion."],
    [otherFile, "# Day\nBought groceries and cleaned the room."],
    [sensitiveFile, "# Secret\nNewtonian force notes with a password."]
  ]);
  const app = {
    vault: {
      getMarkdownFiles: () => [...contents.keys()],
      cachedRead: async (file: TFile) => contents.get(file) ?? ""
    }
  } as App;
  const guard = {
    inspectFile: (file: TFile) => ({ sensitive: file === sensitiveFile, reasons: [] })
  } as SensitiveContentGuard;
  const index = new VaultRetrievalIndex(app, () => [], guard);
  await index.initialize();
  const result = await index.search("force acceleration", 5);
  assert.equal(result.results[0]?.path, "Study/Physics.md");
  assert.equal(result.results[0]?.citation, "[[Study/Physics#Mechanics]]");
  assert.equal(result.skippedSensitiveNotes, 1);
});

test("bundled EXP skill has valid metadata, workflow, references, and calibration", () => {
  assert.match(EXP_SKILL, /^---\nname: exp\ndescription: .+\n---/);
  assert.match(EXP_SKILL, /25 to 1000/);
  assert.match(EXP_SKILL, /references\/rubric\.md/);
  assert.match(EXP_SKILL, /references\/examples\.md/);
  assert.match(EXP_RUBRIC, /Round to the nearest 25/);
  assert.match(EXP_EXAMPLES, /Read 15 pages of the Bible: 200 EXP/);
  assert.match(EXP_AGENT_METADATA, /default_prompt: "Use \$exp/);
  assert.doesNotMatch(`${EXP_SKILL}${EXP_RUBRIC}${EXP_EXAMPLES}`, /TODO/);
});
