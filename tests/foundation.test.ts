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
import { reciprocalRankFusion, VaultRetrievalIndex, type RankedChunk } from "../src/retrieval-index";
import type { SkillRegistry } from "../src/skill-registry";
import type { App, TFile } from "obsidian";
import type { SensitiveContentGuard } from "../src/sensitive-content";
import { EXP_AGENT_METADATA, EXP_EXAMPLES, EXP_RUBRIC, EXP_SKILL } from "../src/bundled-exp-skill";
import { ensureFolders } from "../src/folder-layout";
import {
  OmnisearchProvider,
  type OmnisearchApi,
  type OmnisearchApiResult
} from "../src/omnisearch-provider";
import { assembleOpenRouterTools, type FunctionToolDefinition } from "../src/openrouter-tools";
import { paginate, readLeadingPage } from "../src/pagination";
import {
  rankPopularModels,
  rankingDateRange,
  rankTrendingModels,
  type DailyModelRanking
} from "../src/model-rankings";
import { chunkMatchesFilters, prepareMarkdownChunks } from "../src/markdown-chunks";
import { cosineSimilarity, MemorySemanticStore } from "../src/semantic-store";
import type { SemanticChunkRecord } from "../src/semantic-types";
import { SemanticIndexCoordinator } from "../src/semantic-index";
import type { BrainSettings } from "../src/settings";

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

test("semantic chunking is deterministic and embeds curated metadata without YAML noise", () => {
  const file = {
    path: "TaskNotes/Read.md",
    basename: "Read"
  } as TFile;
  const content = [
    "---",
    "id: internal-123",
    "created: 2026-07-27",
    "status: in-progress",
    "priority: high",
    "tags: [study, reading]",
    "---",
    "# Notes",
    "Read fifteen pages and write a short reflection."
  ].join("\n");
  const frontmatter = {
    id: "internal-123",
    created: "2026-07-27",
    status: "in-progress",
    priority: "high",
    tags: ["study", "reading"]
  };
  const first = prepareMarkdownChunks(file, content, frontmatter, false);
  const second = prepareMarkdownChunks(file, content, frontmatter, false);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.id, second[0]?.id);
  assert.match(first[0]?.embeddingText ?? "", /status: in-progress/);
  assert.match(first[0]?.embeddingText ?? "", /priority: high/);
  assert.doesNotMatch(first[0]?.embeddingText ?? "", /internal-123|created:/);
  assert.equal(first[0]?.lineStart, 8);
  assert.equal(first[0]?.citation, "[[TaskNotes/Read#Notes]]");
});

test("semantic filters support folders, tags, and arbitrary frontmatter properties", () => {
  const chunk = prepareMarkdownChunks(
    { path: "TaskNotes/Study/Read.md", basename: "Read" } as TFile,
    "# Notes\nActive recall",
    { tags: ["study", "reading"], status: "in-progress", priority: 2 },
    false
  )[0]!;
  assert.equal(chunkMatchesFilters(chunk as SemanticChunkRecord, {
    folders: ["TaskNotes"],
    tags: ["#study"],
    properties: { status: "in-progress", priority: 2 }
  }), true);
  assert.equal(chunkMatchesFilters(chunk as SemanticChunkRecord, {
    properties: { status: "done" }
  }), false);
});

test("semantic store performs exact cosine search and respects filters", async () => {
  const store = new MemorySemanticStore();
  const record = (
    id: string,
    path: string,
    vector: number[],
    tags: string[]
  ): SemanticChunkRecord => ({
    id,
    path,
    heading: null,
    lineStart: 1,
    lineEnd: 1,
    excerpt: id,
    citation: `[[${path.replace(/\.md$/, "")}]]`,
    embeddingText: id,
    contentHash: id,
    metadata: { tags },
    sensitive: false,
    vector: Float32Array.from(vector),
    modelId: "embedding/test",
    dimensions: vector.length,
    indexVersion: 1,
    chunkerVersion: 1,
    metadataVersion: 1,
    updatedAt: 1
  });
  await store.applyPath("Study/A.md", [record("a", "Study/A.md", [1, 0], ["study"])]);
  await store.applyPath("Journal.md", [record("b", "Journal.md", [0, 1], ["journal"])]);
  const results = await store.nearest(Float32Array.from([0.9, 0.1]), { tags: ["study"] }, 5);
  assert.deepEqual(results.map((result) => result.chunk.id), ["a"]);
  assert.ok(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0])) > 0.999);
});

test("semantic coordinator checkpoints vectors and re-embeds only changed chunks", async () => {
  const file = { path: "Study/Physics.md", basename: "Physics", extension: "md" } as TFile;
  let content = "# Mechanics\nForce and acceleration.";
  const app = {
    vault: {
      getMarkdownFiles: () => [file],
      cachedRead: async () => content
    },
    metadataCache: {
      getFileCache: () => ({ frontmatter: { tags: ["study"], status: "active" } })
    }
  } as unknown as App;
  const settings: BrainSettings = {
    brainFolder: "Brain",
    openRouterSecretId: "",
    interactiveModel: "openrouter/free",
    backgroundModel: "openrouter/free",
    favoriteModels: [],
    embeddingModel: "embedding/test",
    favoriteEmbeddingModels: [],
    useOmnisearch: false,
    useWebSearch: false,
    semanticSearchEnabled: true,
    semanticFolders: ["Study"],
    includeSensitiveSemantic: false,
    semanticSpendCapUsd: 0.25,
    semanticVaultId: "test",
    excludedPaths: [],
    sensitiveTags: []
  };
  const store = new MemorySemanticStore();
  let embeddingCalls = 0;
  const provider = {
    listEmbeddingModels: async () => [],
    embed: async (_model: string, inputs: string[]) => {
      embeddingCalls += 1;
      return {
        vectors: inputs.map(() => Float32Array.from([1, 0])),
        promptTokens: 10,
        totalTokens: 10
      };
    }
  };
  const coordinator = new SemanticIndexCoordinator(
    app,
    () => settings,
    () => [],
    { inspectFile: () => ({ sensitive: false, reasons: [] }) } as unknown as SensitiveContentGuard,
    store,
    provider,
    () => [{ id: "embedding/test", pricing: { prompt: "0.000001" } }]
  );
  await coordinator.start("rebuild");
  assert.equal(embeddingCalls, 1);
  assert.equal((await store.getAll()).length, 1);
  assert.equal(coordinator.getStatus().partial, false);

  await coordinator.start("rebuild");
  assert.equal(embeddingCalls, 1);

  content = "# Mechanics\nForce, acceleration, and momentum.";
  await coordinator.start("vault-change");
  assert.equal(embeddingCalls, 2);
  assert.match((await store.getAll())[0]?.excerpt ?? "", /momentum/);
});

test("semantic coordinator pauses before exceeding the configured spend cap", async () => {
  const file = { path: "Study/Large.md", basename: "Large", extension: "md" } as TFile;
  const app = {
    vault: {
      getMarkdownFiles: () => [file],
      cachedRead: async () => `# Large\n${"expensive text ".repeat(300)}`
    },
    metadataCache: { getFileCache: () => null }
  } as unknown as App;
  const settings: BrainSettings = {
    brainFolder: "Brain",
    openRouterSecretId: "",
    interactiveModel: "openrouter/free",
    backgroundModel: "openrouter/free",
    favoriteModels: [],
    embeddingModel: "embedding/expensive",
    favoriteEmbeddingModels: [],
    useOmnisearch: false,
    useWebSearch: false,
    semanticSearchEnabled: true,
    semanticFolders: ["Study"],
    includeSensitiveSemantic: false,
    semanticSpendCapUsd: 0.25,
    semanticVaultId: "test-cap",
    excludedPaths: [],
    sensitiveTags: []
  };
  let calls = 0;
  const coordinator = new SemanticIndexCoordinator(
    app,
    () => settings,
    () => [],
    { inspectFile: () => ({ sensitive: false, reasons: [] }) } as unknown as SensitiveContentGuard,
    new MemorySemanticStore(),
    {
      listEmbeddingModels: async () => [],
      embed: async () => {
        calls += 1;
        return { vectors: [], promptTokens: 0, totalTokens: 0 };
      }
    },
    () => [{ id: "embedding/expensive", pricing: { prompt: "1" } }]
  );
  await coordinator.start("rebuild");
  assert.equal(calls, 0);
  assert.equal(coordinator.getStatus().state, "paused");
  assert.match(coordinator.getStatus().lastError ?? "", /spend cap/);
});

test("hybrid rank fusion merges engines and caps chunks per note", () => {
  const ranked = (
    id: string,
    path: string,
    rank: number,
    engine: "lexical" | "semantic"
  ): RankedChunk => ({
    id,
    rank,
    engine,
    rawScore: 1 / rank,
    result: {
      chunkId: id,
      path,
      heading: null,
      lineStart: rank,
      lineEnd: rank,
      excerpt: id,
      score: 0,
      citation: `[[${path.replace(/\.md$/, "")}]]`
    }
  });
  const results = reciprocalRankFusion(
    [ranked("shared", "A.md", 1, "lexical"), ranked("a2", "A.md", 2, "lexical"), ranked("a3", "A.md", 3, "lexical")],
    [ranked("shared", "A.md", 1, "semantic"), ranked("b1", "B.md", 2, "semantic")],
    4
  );
  assert.equal(results[0]?.chunkId, "shared");
  assert.deepEqual(results[0]?.sourceEngines?.sort(), ["lexical", "semantic"]);
  assert.ok(results.filter((result) => result.path === "A.md").length <= 2);
  assert.ok(results.some((result) => result.path === "B.md"));
});

test("Omnisearch is opt-in and filters sensitive and excluded results", async () => {
  const publicFile = { path: "Study/Public.md", extension: "md" } as TFile;
  const privateFile = { path: "Private.md", extension: "md" } as TFile;
  const excludedFile = { path: "Brain/Chats/Chat.md", extension: "md" } as TFile;
  const files = new Map<string, TFile>([
    [publicFile.path, publicFile],
    [privateFile.path, privateFile],
    [excludedFile.path, excludedFile]
  ]);
  const contents = new Map<TFile, string>([
    [publicFile, "# Public\nActive recall is useful."],
    [privateFile, "# Private\nPassword material."],
    [excludedFile, "# Chat\nActive recall conversation."]
  ]);
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      cachedRead: async (file: TFile) => contents.get(file) ?? ""
    }
  } as App;
  const guard = {
    inspectFile: (file: TFile) => ({ sensitive: file === privateFile, reasons: [] })
  } as SensitiveContentGuard;
  let enabled = false;
  let calls = 0;
  const result = (path: string, score: number): OmnisearchApiResult => ({
    score,
    vault: "test-vault",
    path,
    basename: path.replace(/\.md$/, ""),
    foundWords: ["active"],
    matches: [{ match: "Active", offset: 9 }],
    excerpt: `Excerpt from ${path}`
  });
  const api: OmnisearchApi = {
    search: async () => {
      calls += 1;
      return [
        result(publicFile.path, 10),
        result(privateFile.path, 9),
        result(excludedFile.path, 8)
      ];
    },
    refreshIndex: async () => {},
    registerOnIndexed: () => {},
    unregisterOnIndexed: () => {}
  };
  const globalWithOmnisearch = globalThis as typeof globalThis & { omnisearch?: OmnisearchApi };
  globalWithOmnisearch.omnisearch = api;
  try {
    const provider = new OmnisearchProvider(
      app,
      () => enabled,
      () => ["Brain/Chats"],
      guard
    );
    assert.equal((await provider.search("active recall")) ?? null, null);
    assert.equal(calls, 0);

    enabled = true;
    const index = new VaultRetrievalIndex(app, () => ["Brain/Chats"], guard, provider);
    const search = await index.search("active recall");
    assert.equal(calls, 1);
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0]?.path, publicFile.path);
    assert.equal(search.results[0]?.citation, "[[Study/Public]]");
    assert.equal(search.skippedSensitiveNotes, 1);
    assert.equal(index.getStatus().lexicalProvider, "omnisearch");
    assert.deepEqual(provider.getStatus(), { enabled: true, available: true, active: true });
  } finally {
    delete globalWithOmnisearch.omnisearch;
  }
});

test("OpenRouter web search is added only when the setting is enabled", () => {
  const functionTool: FunctionToolDefinition = {
    type: "function",
    function: {
      name: "search_notes",
      description: "Search permitted notes.",
      parameters: { type: "object" }
    }
  };
  assert.deepEqual(assembleOpenRouterTools([functionTool], false), [functionTool]);
  assert.deepEqual(assembleOpenRouterTools([functionTool], true), [
    {
      type: "openrouter:web_search",
      parameters: { engine: "auto", max_results: 5 }
    },
    functionTool
  ]);
});

test("pagination preserves every item across 30-row pages", () => {
  const items = Array.from({ length: 65 }, (_, index) => index + 1);
  const first = paginate(items, 1);
  const second = paginate(items, 2);
  const third = paginate(items, 3);
  const missing = paginate(items, 4);
  assert.equal(first.items.length, 30);
  assert.deepEqual(second.items, items.slice(30, 60));
  assert.deepEqual(third.items, items.slice(60));
  assert.equal(third.totalPages, 3);
  assert.equal(third.hasPrevious, true);
  assert.equal(third.hasNext, false);
  assert.equal(missing.outOfRange, true);
  assert.deepEqual(readLeadingPage(["2", "llama"]), { page: 2, remaining: ["llama"] });
  assert.deepEqual(readLeadingPage(["llama"]), { page: 1, remaining: ["llama"] });
});

test("model usage rankings aggregate popularity and positive growth", () => {
  const rows: DailyModelRanking[] = [
    { date: "2026-07-24", model_permaslug: "model/a", total_tokens: "100" },
    { date: "2026-07-24", model_permaslug: "model/b", total_tokens: "200" },
    { date: "2026-07-25", model_permaslug: "model/a", total_tokens: "300" },
    { date: "2026-07-25", model_permaslug: "model/b", total_tokens: "100" },
    { date: "2026-07-26", model_permaslug: "model/a", total_tokens: "700" },
    { date: "2026-07-26", model_permaslug: "model/b", total_tokens: "50" },
    { date: "2026-07-27", model_permaslug: "model/a", total_tokens: "900" },
    { date: "2026-07-27", model_permaslug: "model/b", total_tokens: "50" },
    { date: "2026-07-27", model_permaslug: "other", total_tokens: "999999" }
  ];
  const popular = rankPopularModels(rows);
  assert.equal(popular[0]?.modelId, "model/a");
  assert.equal(popular[0]?.totalTokens, 2000n);
  const trending = rankTrendingModels(rows, 2);
  assert.equal(trending.length, 1);
  assert.equal(trending[0]?.modelId, "model/a");
  assert.equal(trending[0]?.growthTokens, 1200n);
  assert.deepEqual(rankingDateRange(7, new Date("2026-07-27T12:00:00Z")), {
    startDate: "2026-07-20",
    endDate: "2026-07-26"
  });
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
