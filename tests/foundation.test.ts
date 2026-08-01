import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { canonicalSkillName, skillAliases } from "../src/skill-aliases";
import type { App, TFile } from "obsidian";
import type { SensitiveContentGuard } from "../src/sensitive-content";
import { EXP_AGENT_METADATA, EXP_EXAMPLES, EXP_RUBRIC, EXP_SCHEMA, EXP_SKILL } from "../src/bundled-exp-skill";
import { ensureFolders } from "../src/folder-layout";
import {
  OmnisearchProvider,
  type OmnisearchApi,
  type OmnisearchApiResult
} from "../src/omnisearch-provider";
import {
  assembleOpenRouterTools,
  legacyWebPluginFor,
  splitOpenRouterTools,
  type FunctionToolDefinition
} from "../src/openrouter-tools";
import { paginate, readLeadingPage } from "../src/pagination";
import {
  rankPopularModels,
  rankingDateRange,
  rankTrendingModels,
  type DailyModelRanking
} from "../src/model-rankings";
import { chunkMatchesFilters, prepareMarkdownChunks } from "../src/markdown-chunks";
import { cosineSimilarity, MemorySemanticStore } from "../src/semantic-store";
import type { EmbeddingModel, SemanticChunkRecord } from "../src/semantic-types";
import { SemanticIndexCoordinator } from "../src/semantic-index";
import type { BrainSettings } from "../src/settings";
import { MemoryLexicalIndexStore } from "../src/retrieval-store";
import { PerformanceTracer } from "../src/performance";
import { compactEmbeddingModel, compactOpenRouterModel } from "../src/catalog-models";
import { MemoryCatalogStore } from "../src/catalog-store";
import type { OpenRouterModel } from "../src/types";
import { TaskService } from "../src/task-service";
import { TaskNotesProvider } from "../src/tasknotes-provider";
import { formatExpTaskTitle, stripExpTitlePrefix, taskDisplayTitle } from "../src/task-provider";
import { calculateExpStreaks, validateExpInput, validateExpTransition } from "../src/exp-core";
import type { ExpService } from "../src/exp-service";
import { parseSkillInvocation } from "../src/skill-invocation";
import { parseExpScoringResponse, type ExpAutoScorer } from "../src/exp-auto-scorer";
import { extractFileMentions, fileMention, findAtQuery } from "../src/file-mentions";
import { ExpCompletionCoordinator } from "../src/exp-completion";
import {
  completionMeetsCutoff,
  completionProposalId,
  isExpCompletionCutoff,
  type ExpCompletionProposal
} from "../src/exp-completion-core";
import { chooseWritingCoachInterval } from "../src/writing-coach-core";
import { parseBufferedChatCompletion } from "../src/openrouter-response";

const call = (name: string, input: unknown) => ({
  id: `call_${name}`,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(input) }
});

test("release metadata versions stay aligned", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as {
    id: string;
    version: string;
    minAppVersion: string;
  };
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { name: string; version: string };
  const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
    name: string;
    version: string;
    packages: Record<string, { name?: string; version?: string }>;
  };

  assert.equal(manifest.id, "brain-cli");
  assert.equal(packageJson.name, manifest.id);
  assert.equal(packageLock.name, manifest.id);
  assert.equal(packageJson.version, manifest.version);
  assert.equal(packageLock.version, manifest.version);
  assert.equal(packageLock.packages[""]?.version, manifest.version);
  const versions = JSON.parse(readFileSync("versions.json", "utf8")) as Record<string, string>;
  assert.equal(versions[manifest.version], manifest.minAppVersion);
});

test("buffered OpenRouter completions preserve content and function calls", () => {
  const rendered: string[] = [];
  const result = parseBufferedChatCompletion({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "I will inspect that note.",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_note", arguments: { path: "Notes/example.md" } }
        }]
      }
    }]
  }, (content) => rendered.push(content));

  assert.deepEqual(rendered, ["I will inspect that note."]);
  assert.equal(result.content, "I will inspect that note.");
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.toolCalls, [{
    id: "call_1",
    type: "function",
    function: { name: "read_note", arguments: '{"path":"Notes/example.md"}' }
  }]);
  assert.throws(
    () => parseBufferedChatCompletion({ choices: [{ message: { tool_calls: [{ function: {} }] } }] }),
    /without a function name/
  );
  assert.throws(
    () => parseBufferedChatCompletion({ error: { message: "provider unavailable" } }),
    /provider unavailable/
  );
});

test("privacy and startup guards remain wired into the plugin source", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const layoutReady = main.indexOf("this.app.workspace.onLayoutReady(() => {");
  const registerEvents = main.indexOf("this.registerVaultIndexEvents();");
  assert.ok(layoutReady >= 0 && registerEvents > layoutReady);
  assert.match(main, /brainPath\(this\.settings, "Memory"\)/);

  const sensitivity = readFileSync("src/sensitive-content.ts", "utf8");
  assert.match(sensitivity, /frontmatter\?\.sensitivity === "review"/);

  const memory = readFileSync("src/memory-service.ts", "utf8");
  assert.match(memory, /normalized\.startsWith\(`\$\{memoryRoot\}\/`\)/);
  assert.match(memory, /if \(!await this\.read\(file\)\)/);
  assert.match(memory, /frontmatter\.type !== "memory"/);

  const vaultTools = readFileSync("src/vault-tools.ts", "utf8");
  assert.match(vaultTools, /async snapshotMarkdown[\s\S]*?this\.app\.vault\.read\(file\)/);
  assert.match(vaultTools, /async replaceMarkdown[\s\S]*?this\.app\.vault\.process\(file/);
  assert.match(vaultTools, /async appendMarkdown[\s\S]*?this\.app\.vault\.process\(file/);
  assert.match(vaultTools, /async applyPatch[\s\S]*?this\.app\.vault\.process\(file/);

  const openRouter = readFileSync("src/openrouter.ts", "utf8");
  assert.doesNotMatch(openRouter, /\bfetch\s*\(/);
  assert.match(openRouter, /requestUrl\(request\)/);
  assert.match(openRouter, /stream:\s*false/);
});

test("transcript content explicitly restores native text selection", () => {
  const styles = readFileSync("styles.css", "utf8");
  assert.match(styles, /\.brain-cli-transcript,[\s\S]*?-webkit-user-select:\s*text;/);
  assert.match(styles, /\.brain-cli-message-body,[\s\S]*?cursor:\s*text;/);
});

test("calendar scheduling guidance stays TaskNotes-backed and honest about Google sync", () => {
  const chatView = readFileSync("src/chat-view.ts", "utf8");
  assert.match(chatView, /Calendar scheduling is task-backed/);
  assert.match(chatView, /call query_tasks first/);
  assert.match(chatView, /tasks\.active\.provider is tasknotes/);
  assert.match(chatView, /Never claim the external calendar event was verified/);
  assert.doesNotMatch(chatView, /Google Calendar API key/i);
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
    } as SkillRegistry,
    {
      getStatus: () => ({
        active: { provider: "markdown", available: true, reason: "test" },
        tasknotes: { provider: "tasknotes", available: false, reason: "test" },
        fallback: { provider: "markdown", available: true, reason: "test" }
      }),
      list: async () => [],
      get: async () => null,
      create: async () => { throw new Error("not configured"); },
      update: async () => { throw new Error("not configured"); },
      complete: async () => { throw new Error("not configured"); }
    } as unknown as TaskService,
    {
      progress: async () => ({
        total: 0,
        today: 0,
        last7Days: 0,
        last30Days: 0,
        currentStreak: 0,
        longestStreak: 0,
        level: 1,
        levelProgress: 0,
        nextLevelAt: 1000,
        awards: 0,
        recent: []
      }),
      review: async () => ({
        days: 30,
        awards: 0,
        average: 0,
        median: 0,
        lowConfidence: 0,
        buckets: [],
        commonScores: [],
        observations: [],
        recent: []
      }),
      taskState: async () => null,
      record: async () => { throw new Error("not configured"); },
      validate: (input: unknown) => input
    } as unknown as ExpService
    ,
    {
      create: async () => { throw new Error("not configured"); },
      search: async () => [],
      setStatus: async () => { throw new Error("not configured"); }
    } as never
    ,
    {
      status: () => null,
      start: async () => { throw new Error("not configured"); },
      checkNow: async () => { throw new Error("not configured"); },
      stop: async () => { throw new Error("not configured"); }
    } as never
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

test("@ skill invocations support toggles and inline prompts", () => {
  assert.deepEqual(parseSkillInvocation("@exp"), { name: "exp", prompt: "" });
  assert.deepEqual(parseSkillInvocation("@EXP history"), { name: "exp", prompt: "history" });
  assert.deepEqual(parseSkillInvocation("@exp score this completed task"), {
    name: "exp",
    prompt: "score this completed task"
  });
  assert.equal(parseSkillInvocation("@"), null);
  assert.equal(parseSkillInvocation("@bad/name prompt"), null);
  assert.equal(canonicalSkillName("cwc"), "continual-writing-coach");
  assert.equal(canonicalSkillName("CONTINUAL-WRITING-COACH"), "continual-writing-coach");
  assert.deepEqual(skillAliases("continual-writing-coach"), ["cwc"]);
});

test("writing-coach ranges choose inclusive delays and preserve fixed intervals", () => {
  assert.equal(chooseWritingCoachInterval(5, 10, () => 0), 5);
  assert.equal(chooseWritingCoachInterval(5, 10, () => 0.999999), 10);
  assert.equal(chooseWritingCoachInterval(7, 7, () => 0.5), 7);
});

test("@ file mentions identify the active token and preserve canonical vault paths", () => {
  assert.deepEqual(findAtQuery("@2026", 5), { query: "2026", start: 0, end: 5 });
  assert.deepEqual(findAtQuery("compare @daily", 14), { query: "daily", start: 8, end: 14 });
  assert.equal(findAtQuery("compare @[[Dailies/2026-07-20.md]]", 37), null);
  assert.equal(fileMention("Dailies\\2026-07-20.md"), "@[[Dailies/2026-07-20.md]]");
  assert.deepEqual(
    extractFileMentions(
      "compare @[[Dailies/2026-07-20.md|Monday]] with @[[Notes/example.md#Section]] and @[[Dailies/2026-07-20.md]]"
    ),
    ["Dailies/2026-07-20.md", "Notes/example.md"]
  );
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
    "Brain/Coaching",
    "Brain/EXP",
    "Brain/EXP/Ledger",
    "Brain/Settings",
    "Brain/Queue",
    "Brain/Skills"
  ];

  await ensureFolders(adapter, paths);
  await ensureFolders(adapter, paths);

  assert.deepEqual(createCalls, [
    "Brain/Memory",
    "Brain/Calibration",
    "Brain/Coaching",
    "Brain/EXP",
    "Brain/EXP/Ledger",
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
    "Brain/Coaching",
    "Brain/EXP",
    "Brain/EXP/Ledger",
    "Brain/Settings",
    "Brain/Queue",
    "Brain/Skills"
  ]);
  assert.equal(folders.size, 10);
});

test("registry exposes the complete foundational tool surface", () => {
  const registry = makeRegistry({} as VaultTools);
  assert.deepEqual(
    registry.definitions().map((tool) => tool.function.name),
    [
      "get_writing_coach",
      "start_writing_coach",
      "check_writing_coach",
      "stop_writing_coach",
      "search_memory",
      "record_memory",
      "update_memory_status",
      "get_environment",
      "list_notes",
      "read_note",
      "search_notes",
      "retrieve_context",
      "query_tasks",
      "get_task",
      "get_task_exp",
      "get_exp_progress",
      "review_exp_calibration",
      "get_exp_analytics",
      "create_exp_goal",
      "record_task_exp",
      "create_task",
      "update_task",
      "complete_task",
      "add_task_dependency",
      "remove_task_dependency",
      "start_task_timer",
      "stop_task_timer",
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
  assert.equal(registry.riskFor("get_exp_progress"), "read");
  assert.equal(registry.riskFor("get_writing_coach"), "read");
  assert.equal(registry.riskFor("start_writing_coach"), "high-write");
  assert.equal(registry.riskFor("check_writing_coach"), "low-write");
  assert.equal(registry.riskFor("stop_writing_coach"), "low-write");
  assert.equal(registry.riskFor("record_memory"), "low-write");
  assert.equal(registry.riskFor("create_exp_goal"), "low-write");
  assert.equal(registry.riskFor("record_task_exp"), "high-write");
  assert.equal(registry.riskFor("create_note"), "high-write");
  assert.equal(registry.riskFor("missing"), null);
  const createTask = registry.definitions().find((tool) => tool.function.name === "create_task");
  const updateTask = registry.definitions().find((tool) => tool.function.name === "update_task");
  assert.match(createTask?.function.description ?? "", /configured Google Calendar connection/);
  assert.match(updateTask?.function.description ?? "", /verifies the TaskNotes mutation, not the external event/);
  assert.match(JSON.stringify(createTask?.function.parameters), /YYYY-MM-DDTHH:mm/);
  assert.match(JSON.stringify(createTask?.function.parameters), /exported calendar duration/);
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
  const environmentResult = environment.result as { capabilities: string[]; limitations: string[] };
  assert.ok(environmentResult.capabilities.some((value) => value.includes("task-backed calendar blocks")));
  assert.ok(environmentResult.limitations.some((value) => value.includes("Markdown fallback")));

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

test("TaskNotes provider uses runtime API v1 and verifies task mutations", async () => {
  const tasks = new Map<string, Record<string, unknown>>([
    ["TaskNotes/Tasks/read.md", {
      path: "TaskNotes/Tasks/read.md",
      title: "Read 15 pages",
      status: "open",
      priority: "normal",
      tags: ["study"],
      exp: 200,
      exp_state: "planned"
    }],
    ["TaskNotes/Tasks/done.md", {
      path: "TaskNotes/Tasks/done.md",
      title: "Finished",
      status: "done",
      priority: "normal",
      tags: "#study",
      completedDate: "2026-07-28"
    }]
  ]);
  let readyCalls = 0;
  const api = {
    apiVersion: 1,
    hasCapability: (name: string) => ["tasks.read", "tasks.write", "time.write"].includes(name),
    lifecycle: { ready: async () => { readyCalls += 1; } },
    tasks: {
      list: async () => [...tasks.values()],
      get: async (path: string) => tasks.get(path) ?? null,
      create: async (input: Record<string, unknown>) => {
        const task = { ...input, path: "TaskNotes/Tasks/created.md" };
        tasks.set(String(task.path), task);
        return task;
      },
      update: async (path: string, patch: Record<string, unknown>) => {
        const task = { ...tasks.get(path), ...patch };
        tasks.set(path, task);
        return task;
      },
      complete: async (path: string) => {
        const task = { ...tasks.get(path), status: "done" };
        tasks.set(path, task);
        return task;
      },
      addDependency: async (path: string, dependency: Record<string, unknown>) => {
        const task = { ...tasks.get(path), blockedBy: [dependency] };
        tasks.set(path, task);
        return task;
      },
      removeDependency: async (path: string) => {
        const task = { ...tasks.get(path), blockedBy: [] };
        tasks.set(path, task);
        return task;
      }
    },
    time: {
      start: async (path: string) => {
        const task = { ...tasks.get(path), timeEntries: [{ startTime: "2026-07-28T00:00:00Z" }] };
        tasks.set(path, task);
        return task;
      },
      stop: async (path: string) => {
        const task = {
          ...tasks.get(path),
          timeEntries: [{ startTime: "2026-07-28T00:00:00Z", endTime: "2026-07-28T01:00:00Z" }]
        };
        tasks.set(path, task);
        return task;
      }
    }
  };
  const app = {
    metadataCache: {
      getCache: () => null
    },
    plugins: {
      getPlugin: (id: string) => id === "tasknotes" ? { api } : null,
      plugins: { tasknotes: { api } }
    }
  } as unknown as App;
  const provider = new TaskNotesProvider(app);

  assert.equal(provider.status().available, true);
  const studyTasks = await provider.list({ tags: ["study"] });
  assert.deepEqual(studyTasks.map((task) => task.title), ["Read 15 pages"]);
  assert.equal(studyTasks[0]?.exp, 200);
  assert.equal(studyTasks[0]?.expState, "planned");
  assert.equal(taskDisplayTitle(studyTasks[0]!), "[200] Read 15 pages");
  const completedToday = await provider.list({ includeCompleted: true, completedOn: "2026-07-28" });
  assert.deepEqual(completedToday.map((task) => task.title), ["Finished"]);
  const created = await provider.create({
    title: "Created task",
    priority: "high",
    scheduled: "2026-08-01T09:00",
    timeEstimate: 90
  });
  assert.equal(created.path, "TaskNotes/Tasks/created.md");
  assert.equal(created.scheduled, "2026-08-01T09:00");
  assert.equal(created.timeEstimate, 90);
  assert.equal((await provider.update(created.path, { due: "2026-08-01" })).due, "2026-08-01");
  assert.equal((await provider.addDependency(created.path, {
    uid: "TaskNotes/Tasks/read.md"
  })).dependencies[0]?.uid, "TaskNotes/Tasks/read.md");
  assert.equal((await provider.removeDependency(created.path, "TaskNotes/Tasks/read.md")).dependencies.length, 0);
  assert.equal((await provider.startTimer(created.path, "Deep work")).timeTrackingActive, true);
  assert.equal((await provider.stopTimer(created.path)).timeTrackingActive, false);
  assert.equal((await provider.complete(created.path)).completed, true);
  assert.ok(readyCalls >= 8);
});

test("TaskNotes provider fails closed for unsupported API versions and missing task capabilities", async () => {
  const providerFor = (api: Record<string, unknown>): TaskNotesProvider => new TaskNotesProvider({
    metadataCache: { getCache: () => null },
    plugins: { getPlugin: () => ({ api }) }
  } as unknown as App);

  const unsupported = providerFor({ apiVersion: 2 });
  assert.equal(unsupported.status().available, false);
  assert.match(unsupported.status().reason, /API v2 is unsupported/);

  const missingRead = providerFor({
    apiVersion: 1,
    hasCapability: (name: string) => name !== "tasks.read"
  });
  assert.equal(missingRead.status().available, false);
  assert.match(missingRead.status().reason, /tasks\.read capability/);

  const missingWrite = providerFor({
    apiVersion: 1,
    hasCapability: (name: string) => name !== "tasks.write"
  });
  assert.equal(missingWrite.status().available, false);
  assert.match(missingWrite.status().reason, /tasks\.write capability/);
});

test("task service uses full-note sensitivity checks and fails closed while listing", async () => {
  const tasks = [
    {
      path: "TaskNotes/Tasks/public.md",
      title: "Public",
      status: "open",
      priority: null,
      due: null,
      scheduled: null,
      tags: [],
      contexts: [],
      projects: [],
      timeEstimate: null,
      exp: null,
      expState: null,
      recurrence: null,
      dependencies: [],
      timeTrackingActive: false,
      completed: false,
      provider: "markdown",
      citation: "[[TaskNotes/Tasks/public]]"
    },
    {
      path: "TaskNotes/Tasks/private.md",
      title: "Private",
      status: "open",
      priority: null,
      due: null,
      scheduled: null,
      tags: [],
      contexts: [],
      projects: [],
      timeEstimate: null,
      exp: null,
      expState: null,
      recurrence: null,
      dependencies: [],
      timeTrackingActive: false,
      completed: false,
      provider: "markdown",
      citation: "[[TaskNotes/Tasks/private]]"
    }
  ];
  const provider = {
    status: () => ({ provider: "markdown", available: true, reason: "test" }),
    list: async () => tasks,
    get: async (path: string) => tasks.find((task) => task.path === path) ?? null
  };
  const service = new TaskService(
    { status: () => ({ provider: "tasknotes", available: false, reason: "test" }) } as never,
    provider as never,
    () => [],
    {
      inspectPath: async (path: string) => ({
        sensitive: path.endsWith("private.md"),
        reasons: path.endsWith("private.md") ? ["frontmatter marks the note as sensitive"] : []
      })
    } as SensitiveContentGuard
  );
  assert.deepEqual((await service.list()).map((task) => task.title), ["Public"]);
  await assert.rejects(() => service.get("TaskNotes/Tasks/private.md"), /Sensitive task approval required/);
  assert.equal((await service.get("TaskNotes/Tasks/private.md", true))?.title, "Private");
});

test("EXP task titles replace old prefixes and shorten cleanly at word boundaries", () => {
  assert.equal(formatExpTaskTitle("Read fifteen pages", 200), "[200] Read fifteen pages");
  assert.equal(formatExpTaskTitle("[100] Read fifteen pages", 225), "[225] Read fifteen pages");
  const shortened = formatExpTaskTitle(
    "Write a deliberately long task title that should lose trailing words cleanly",
    150,
    48
  );
  assert.ok(shortened.startsWith("[150] Write a deliberately long task"));
  assert.ok(shortened.endsWith("…"));
  assert.ok(shortened.length <= 48);
  assert.equal(stripExpTitlePrefix(shortened).startsWith("Write"), true);
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

test("whole-note replacement binds approval to the previewed snapshot", async () => {
  let replacement: { path: string; content: string; expected?: string } | null = null;
  const registry = makeRegistry({
    snapshotMarkdown: async () => "original contents",
    replaceMarkdown: async (path: string, content: string, expected?: string) => {
      replacement = { path, content, expected };
    }
  } as VaultTools);
  const replace = call("replace_note", { path: "Note.md", content: "new contents" });
  const inspection = await registry.inspect(replace);
  assert.equal(inspection.expectedContent, "original contents");
  assert.equal(inspection.preview?.before, "original contents");
  const result = await registry.execute(replace, {
    allowSensitive: false,
    expectedContent: inspection.expectedContent
  });
  assert.equal(result.ok, true);
  assert.deepEqual(replacement, {
    path: "Note.md",
    content: "new contents",
    expected: "original contents"
  });
});

test("task tools expose readable intent and result previews instead of raw JSON", async () => {
  const registry = makeRegistry({} as VaultTools);
  const queryCall = call("query_tasks", {
    tags: ["study"],
    due_before: "2026-07-31",
    include_completed: true,
    limit: 20
  });
  const query = await registry.inspect(queryCall);
  assert.equal(query.preview?.title, "Find tasks");
  assert.match(query.preview?.details ?? "", /Tags: study/);
  assert.match(query.preview?.details ?? "", /Completed tasks: included/);
  assert.doesNotMatch(query.preview?.details ?? "", /[{}"]/);

  const result = registry.resultPreview(queryCall, {
    provider: "tasknotes",
    count: 1,
    tasks: [{
      title: "Read 15 pages",
      displayTitle: "[200] Read 15 pages",
      status: "open",
      due: "2026-07-31"
    }]
  });
  assert.equal(result?.title, "1 matching task");
  assert.equal(result?.afterLabel, "Results");
  assert.match(result?.after ?? "", /\[200\] Read 15 pages — open · due 2026-07-31/);
  assert.equal(registry.displayName("add_task_dependency"), "Add task dependency");
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

test("lexical retrieval restores unchanged notes without rereading their contents", async () => {
  const file = {
    path: "Study/Cached.md",
    extension: "md",
    basename: "Cached",
    stat: { mtime: 123, ctime: 100, size: 32 }
  } as TFile;
  let reads = 0;
  const app = {
    vault: {
      getMarkdownFiles: () => [file],
      cachedRead: async () => {
        reads += 1;
        return "# Cached\nPersistent retrieval content.";
      }
    },
    metadataCache: { getFileCache: () => ({ frontmatter: undefined }) }
  } as unknown as App;
  const guard = { inspectFile: () => ({ sensitive: false, reasons: [] }) } as unknown as SensitiveContentGuard;
  const store = new MemoryLexicalIndexStore();

  const first = new VaultRetrievalIndex(app, () => [], guard, undefined, undefined, store);
  await first.initialize();
  assert.equal(reads, 1);
  assert.equal(first.getStatus().persistence.updatedNotes, 1);

  reads = 0;
  const restored = new VaultRetrievalIndex(app, () => [], guard, undefined, undefined, store);
  await restored.initialize();
  assert.equal(reads, 0);
  assert.equal(restored.getStatus().persistence.restoredNotes, 1);
  assert.equal((await restored.search("persistent", 3)).results[0]?.path, "Study/Cached.md");
});

test("performance tracer aggregates local timings and can reset them", () => {
  const tracer = new PerformanceTracer();
  tracer.record("vault.search", 4);
  tracer.record("vault.search", 8);
  assert.deepEqual(tracer.summaries(), [{
    name: "vault.search",
    count: 2,
    lastMs: 8,
    averageMs: 6,
    maximumMs: 8
  }]);
  assert.match(tracer.report(), /vault\.search/);
  tracer.reset();
  assert.equal(tracer.summaries().length, 0);
});

test("catalog cache stores compact model records outside plugin settings", async () => {
  const compact = compactOpenRouterModel({
    id: "provider/model",
    name: "Model",
    context_length: 32_000,
    pricing: { prompt: "0.1", completion: "0.2" },
    supported_parameters: ["tools"],
    description: "unused large description"
  } as OpenRouterModel & { description: string });
  assert.deepEqual(Object.keys(compact).sort(), [
    "architecture",
    "canonical_slug",
    "context_length",
    "id",
    "name",
    "pricing",
    "supported_parameters",
    "top_provider"
  ]);
  assert.equal("description" in compact, false);

  const embedding = compactEmbeddingModel({
    id: "provider/embedding",
    name: "Embedding",
    description: "Searchable",
    context_length: 8_192
  });
  const store = new MemoryCatalogStore();
  await store.set("models", { fetchedAt: 1, rows: [compact] });
  await store.set("embeddings", { fetchedAt: 2, rows: [embedding] });
  assert.equal((await store.get<{ rows: OpenRouterModel[] }>("models"))?.rows[0]?.id, "provider/model");
  assert.equal((await store.get<{ rows: EmbeddingModel[] }>("embeddings"))?.rows[0]?.description, "Searchable");
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

test("semantic chunking bounds huge source lines and embedding inputs", () => {
  const chunks = prepareMarkdownChunks(
    { path: "Study/Huge.md", basename: "Huge" } as TFile,
    `# Imported data\n${"x".repeat(20_000)}`,
    { description: "m".repeat(10_000) },
    false
  );
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.embeddingText.length <= 3_000));
  assert.ok(chunks.every((chunk) => chunk.excerpt.length <= 2_500));
  assert.ok(chunks.every((chunk) => chunk.lineStart <= chunk.lineEnd));
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
    autoScoreTaskExp: false,
    autoExpSpendCapUsd: 0.10,
    autoExpQueue: [],
    fallbackTaskFolder: "TaskNotes/Tasks",
    expTitleMaxLength: 100,
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
  assert.equal(coordinator.getStatus().totalNotes, 1);
  assert.equal(coordinator.getStatus().totalChunks, 1);
  assert.equal(coordinator.getStatus().indexedChunks, 1);
  assert.equal(coordinator.getStatus().queuedNotes, 0);

  await coordinator.start("rebuild");
  assert.equal(embeddingCalls, 1);
  coordinator.queueUpdate({ path: "Outside/not-selected.md" } as TFile);
  assert.equal(coordinator.getStatus().queuedNotes, 0);

  content = "# Mechanics\nForce, acceleration, and momentum.";
  await coordinator.start("vault-change");
  assert.equal(embeddingCalls, 2);
  assert.match((await store.getAll())[0]?.excerpt ?? "", /momentum/);

  await coordinator.clear();
  assert.equal((await store.getAll()).length, 0);
  assert.equal(coordinator.getStatus().indexedChunks, 0);
  assert.equal(coordinator.getStatus().state, "idle");

  await coordinator.refresh();
  assert.equal(embeddingCalls, 3);
  assert.equal((await store.getAll()).length, 1);
  assert.equal(coordinator.getStatus().partial, false);
});

test("semantic coordinator isolates a rejected embedding input instead of stopping the queue", async () => {
  const file = { path: "Study/Mixed.md", basename: "Mixed", extension: "md" } as TFile;
  const content = `# Mixed\n${"first section ".repeat(130)}\n\n${"second section ".repeat(130)}`;
  const app = {
    vault: {
      getMarkdownFiles: () => [file],
      cachedRead: async () => content
    },
    metadataCache: { getFileCache: () => null }
  } as unknown as App;
  const settings = {
    brainFolder: "Brain",
    openRouterSecretId: "",
    interactiveModel: "openrouter/free",
    backgroundModel: "openrouter/free",
    autoScoreTaskExp: false,
    autoExpSpendCapUsd: 0.10,
    autoExpQueue: [],
    fallbackTaskFolder: "TaskNotes/Tasks",
    expTitleMaxLength: 100,
    favoriteModels: [],
    embeddingModel: "embedding/test",
    favoriteEmbeddingModels: [],
    useOmnisearch: false,
    useWebSearch: false,
    semanticSearchEnabled: true,
    semanticFolders: ["Study"],
    includeSensitiveSemantic: false,
    semanticSpendCapUsd: 0.25,
    semanticVaultId: "test-recovery",
    excludedPaths: [],
    sensitiveTags: []
  } satisfies BrainSettings;
  const store = new MemorySemanticStore();
  let calls = 0;
  let singleCalls = 0;
  const coordinator = new SemanticIndexCoordinator(
    app,
    () => settings,
    () => [],
    { inspectFile: () => ({ sensitive: false, reasons: [] }) } as unknown as SensitiveContentGuard,
    store,
    {
      listEmbeddingModels: async () => [],
      embed: async (_model: string, inputs: string[]) => {
        calls += 1;
        if (inputs.length > 1) throw new Error("HTTP 422: input length exceeds model maximum");
        singleCalls += 1;
        if (singleCalls === 2) {
          throw new Error("HTTP 422: input length exceeds model maximum");
        }
        return {
          vectors: [Float32Array.from([1, 0])],
          promptTokens: 5,
          totalTokens: 5
        };
      }
    },
    () => [{ id: "embedding/test", pricing: { prompt: "0.000001" } }]
  );
  await coordinator.start("rebuild");
  assert.ok(calls >= 3);
  assert.equal(coordinator.getStatus().state, "idle");
  assert.equal(coordinator.getStatus().failedChunks, 1);
  assert.equal(coordinator.getStatus().partial, true);
  assert.ok(coordinator.getStatus().completedChunks > 0);
  assert.ok((await store.getAll()).length > 0);
});

test("semantic cancellation aborts the active request and does not restart queued work", async () => {
  const file = { path: "Study/Cancel.md", basename: "Cancel", extension: "md" } as TFile;
  const app = {
    vault: {
      getMarkdownFiles: () => [file],
      cachedRead: async () => "# Cancel\nThis request should be aborted."
    },
    metadataCache: { getFileCache: () => null }
  } as unknown as App;
  const settings = {
    brainFolder: "Brain",
    fallbackTaskFolder: "TaskNotes/Tasks",
    openRouterSecretId: "",
    interactiveModel: "openrouter/free",
    backgroundModel: "openrouter/free",
    autoScoreTaskExp: false,
    autoExpSpendCapUsd: 0.10,
    autoExpQueue: [],
    expTitleMaxLength: 100,
    favoriteModels: [],
    embeddingModel: "embedding/test",
    favoriteEmbeddingModels: [],
    useOmnisearch: false,
    useWebSearch: false,
    semanticSearchEnabled: true,
    semanticFolders: ["Study"],
    includeSensitiveSemantic: false,
    semanticSpendCapUsd: 0.25,
    semanticVaultId: "test-cancel",
    excludedPaths: [],
    sensitiveTags: []
  } satisfies BrainSettings;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const coordinator = new SemanticIndexCoordinator(
    app,
    () => settings,
    () => [],
    { inspectFile: () => ({ sensitive: false, reasons: [] }) } as unknown as SensitiveContentGuard,
    new MemorySemanticStore(),
    {
      listEmbeddingModels: async () => [],
      embed: async (_model: string, _inputs: string[], signal: AbortSignal) => {
        calls += 1;
        started();
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
    },
    () => [{ id: "embedding/test", pricing: { prompt: "0" } }]
  );
  const running = coordinator.start("rebuild");
  await requestStarted;
  coordinator.queueUpdate(file);
  coordinator.cancel();
  await running;
  assert.equal(calls, 1);
  assert.equal(coordinator.getStatus().state, "cancelled");
  assert.equal(coordinator.getStatus().queuedNotes, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
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
    autoScoreTaskExp: false,
    autoExpSpendCapUsd: 0.10,
    autoExpQueue: [],
    fallbackTaskFolder: "TaskNotes/Tasks",
    expTitleMaxLength: 100,
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
  const split = splitOpenRouterTools(assembleOpenRouterTools([functionTool], true));
  assert.deepEqual(split.functionTools, [functionTool]);
  assert.deepEqual(split.webSearchTool, {
    type: "openrouter:web_search",
    parameters: { engine: "auto", max_results: 5 }
  });
  assert.deepEqual(legacyWebPluginFor(split.webSearchTool!), {
    id: "web",
    max_results: 5
  });
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
  assert.match(EXP_SKILL, /^---\nname: exp\ndescription: .+\n[\s\S]*?\n---/);
  assert.match(EXP_SKILL, /completions:\n[\s\S]*value: score/);
  assert.match(EXP_SKILL, /value: check/);
  assert.match(EXP_SKILL, /value: pending/);
  assert.match(EXP_SKILL, /25 to 1000/);
  assert.match(EXP_SKILL, /references\/rubric\.md/);
  assert.match(EXP_SKILL, /references\/examples\.md/);
  assert.match(EXP_SKILL, /record_task_exp/);
  assert.match(EXP_RUBRIC, /Round to the nearest 25/);
  assert.match(EXP_EXAMPLES, /Read 15 pages of the Bible: 200 EXP/);
  assert.match(EXP_SCHEMA, /immutable ordinary Markdown/);
  assert.match(EXP_SCHEMA, /exp_schema: 2/);
  assert.match(EXP_SCHEMA, /model, token usage, cost/);
  assert.match(EXP_AGENT_METADATA, /default_prompt: "Use \$exp/);
  assert.doesNotMatch(`${EXP_SKILL}${EXP_RUBRIC}${EXP_EXAMPLES}${EXP_SCHEMA}`, /TODO/);
});

test("EXP validation enforces calibrated scores and complete factor evidence", () => {
  const valid = {
    path: "TaskNotes/Tasks/read.md",
    action: "award" as const,
    value: 200,
    confidence: 0.8,
    reason: "Meaningful reading completed.",
    factors: {
      output: "15 pages",
      difficulty: "moderate language",
      rigor: "light",
      friction: "low engagement",
      independence: "self-directed",
      significance: "supports a reading goal"
    }
  };
  assert.equal(validateExpInput(valid).value, 200);
  assert.deepEqual(
    {
      scoringSource: validateExpInput({
        ...valid,
        scoringSource: "background-ai",
        modelId: " model/example ",
        promptTokens: 123.9,
        completionTokens: 45.2,
        costUsd: 0.001
      }).scoringSource,
      modelId: validateExpInput({
        ...valid,
        scoringSource: "background-ai",
        modelId: " model/example "
      }).modelId
    },
    { scoringSource: "background-ai", modelId: "model/example" }
  );
  assert.throws(() => validateExpInput({ ...valid, value: 210 }), /nearest 25/);
  assert.throws(() => validateExpInput({ ...valid, path: "../outside.md" }), /vault-relative/);
  assert.throws(() => validateExpInput({
    ...valid,
    factors: { ...valid.factors, rigor: "" }
  }), /rigor/);
});

test("EXP transitions prevent silent overwrites and duplicate awards", () => {
  assert.doesNotThrow(() => validateExpTransition("plan", null));
  assert.doesNotThrow(() => validateExpTransition("recalibrate", { state: "planned" }));
  assert.doesNotThrow(() => validateExpTransition("award", { state: "planned" }));
  assert.doesNotThrow(() => validateExpTransition("award", { state: "earned" }, true));
  assert.throws(() => validateExpTransition("plan", { state: "planned" }), /already has EXP/);
  assert.throws(() => validateExpTransition("recalibrate", null), /existing planned/);
  assert.throws(() => validateExpTransition("recalibrate", { state: "earned" }), /existing planned/);
  assert.throws(() => validateExpTransition("award", { state: "earned" }), /already has earned EXP/);
});

test("automatic EXP scoring parses JSON and normalizes model numbers", () => {
  const parsed = parseExpScoringResponse(JSON.stringify({
    value: 187,
    confidence: 1.2,
    reason: "Meaningful reading output with moderate friction.",
    factors: {
      output: "Fifteen pages read",
      difficulty: "Moderate",
      rigor: "Light",
      friction: "Dense language",
      independence: "Self-directed",
      significance: "Advances a reading goal"
    }
  }), "TaskNotes/Tasks/read.md", "plan");
  assert.equal(parsed.value, 175);
  assert.equal(parsed.confidence, 1);
  assert.equal(parsed.action, "plan");
  assert.equal(parsed.factors.output, "Fifteen pages read");
});

test("automatic EXP scoring rejects malformed numeric model output", () => {
  assert.throws(() => parseExpScoringResponse(JSON.stringify({
    value: "not-a-number",
    confidence: 0.8,
    reason: "invalid",
    factors: {
      output: "x",
      difficulty: "x",
      rigor: "x",
      friction: "x",
      independence: "x",
      significance: "x"
    }
  }), "TaskNotes/Tasks/a.md", "plan"), /invalid numeric/);
});

test("EXP completion cutoffs validate calendar dates and include the cutoff day", () => {
  assert.equal(isExpCompletionCutoff(""), true);
  assert.equal(isExpCompletionCutoff("2026-07-30"), true);
  assert.equal(isExpCompletionCutoff("2026-02-29"), false);
  assert.equal(isExpCompletionCutoff("30-07-2026"), false);
  assert.equal(completionMeetsCutoff("2026-07-29", "2026-07-30"), false);
  assert.equal(completionMeetsCutoff("2026-07-30", "2026-07-30"), true);
  assert.equal(completionMeetsCutoff("2026-07-30T00:15:00+07:00", "2026-07-30"), true);
});

test("completion cutoff baselines old instances and preserves today for reconciliation", async () => {
  const task = {
    path: "TaskNotes/Tasks/recurring.md",
    title: "Recurring",
    status: "done",
    recurrence: "RRULE:FREQ=DAILY",
    completedDate: "2026-07-30",
    completedInstances: ["2026-07-29", "2026-07-30"],
    completed: true
  };
  const settings = {
    detectCompletedTaskExp: true,
    completionExpBaselineReady: false,
    completionExpCutoffDate: "2026-07-30",
    completionExpSeen: {} as Record<string, string[]>,
    autoAwardCompletedTaskExp: false,
    autoScoreCompletedTaskExp: false,
    autoExpSpendCapUsd: 0.1
  };
  let saved: ExpCompletionProposal | null = null;
  const coordinator = new ExpCompletionCoordinator(
    {
      list: async () => [task],
      get: async () => task,
      inspectSensitivity: async () => ({ sensitive: false, reasons: [] })
    } as unknown as TaskService,
    {
      taskState: async () => null,
      hasCompletion: async () => false,
      latestEvent: async () => null
    } as unknown as ExpService,
    {
      proposeAward: async () => { throw new Error("automatic scoring is disabled"); }
    } as unknown as ExpAutoScorer,
    {
      list: async () => saved ? [saved] : [],
      getByCompletion: async (_path: string, token: string) =>
        saved?.completionToken === token ? saved : null,
      save: async (proposal: ExpCompletionProposal) => {
        saved = proposal;
        return proposal;
      },
      remove: async () => { saved = null; },
      renameTask: async () => undefined
    } as never,
    () => settings,
    async () => undefined,
    () => undefined,
    () => undefined
  );

  await coordinator.establishBaseline();
  assert.deepEqual(settings.completionExpSeen[task.path], ["instance:2026-07-29"]);
  const result = await coordinator.reconcileAll();
  assert.equal(result.discovered, 1);
  assert.equal(result.needsScore, 1);
  assert.equal(saved?.completionToken, "instance:2026-07-30");
});
test("completion reconciliation reuses planned EXP, persists approval proposals, and is idempotent", async () => {
  const task = {
    path: "TaskNotes/Tasks/read.md",
    title: "[200] Read",
    status: "done",
    priority: null,
    due: null,
    scheduled: null,
    tags: [],
    contexts: [],
    projects: [],
    timeEstimate: null,
    exp: 200,
    expState: "planned" as const,
    recurrence: "RRULE:FREQ=DAILY",
    completedDate: "2026-07-29",
    completedInstances: ["2026-07-28", "2026-07-29"],
    dependencies: [],
    timeTrackingActive: false,
    completed: true,
    provider: "markdown" as const,
    citation: "[[TaskNotes/Tasks/read]]"
  };
  const settings = {
    detectCompletedTaskExp: true,
    completionExpBaselineReady: true,
    completionExpSeen: {},
    autoAwardCompletedTaskExp: false,
    autoScoreCompletedTaskExp: false,
    autoExpSpendCapUsd: 0.1
  };
  const proposals = new Map<string, ExpCompletionProposal>();
  let persisted = 0;
  const queue = {
    list: async () => [...proposals.values()],
    getByCompletion: async (path: string, token: string) =>
      proposals.get(completionProposalId(path, token)) ?? null,
    save: async (proposal: ExpCompletionProposal) => {
      proposals.set(proposal.id, proposal);
      return proposal;
    },
    remove: async (proposal: ExpCompletionProposal) => {
      proposals.delete(proposal.id);
    },
    renameTask: async () => undefined
  };
  const expState = {
    schema: 2,
    value: 200,
    state: "planned" as const,
    confidence: 0.8,
    reason: "Planned reading output.",
    factors: {
      output: "15 pages",
      difficulty: "moderate",
      rigor: "light",
      friction: "some",
      independence: "independent",
      significance: "meaningful"
    },
    scoredAt: "2026-07-27T00:00:00Z",
    awardedAt: null,
    revision: 1,
    taskId: "task-1",
    lastCompletionId: null
  };
  const coordinator = new ExpCompletionCoordinator(
    {
      list: async () => [task],
      get: async () => task,
      inspectSensitivity: async () => ({ sensitive: false, reasons: [] })
    } as unknown as TaskService,
    {
      taskState: async () => expState,
      hasCompletion: async () => false,
      latestEvent: async () => ({ id: "plan-1" }),
      record: async () => { throw new Error("approval mode must not write"); }
    } as unknown as ExpService,
    {
      proposeAward: async () => { throw new Error("planned EXP must not call a model"); }
    } as unknown as ExpAutoScorer,
    queue as never,
    () => settings,
    async () => { persisted += 1; },
    () => undefined,
    () => undefined
  );
  const first = await coordinator.reconcileAll();
  assert.equal(first.discovered, 2);
  assert.equal(first.queued, 2);
  assert.equal(proposals.size, 2);
  assert.ok([...proposals.values()].every((proposal) =>
    proposal.input?.scoringSource === "planned-reuse"
    && proposal.input.sourceEventId === "plan-1"
  ));
  const second = await coordinator.reconcileAll();
  assert.equal(second.discovered, 0);
  assert.ok(persisted >= 2);
});

test("unscored completions enter the needs-score queue when automatic AI scoring is disabled", async () => {
  const task = {
    path: "TaskNotes/Tasks/unscored.md",
    title: "Unscored",
    status: "done",
    recurrence: null,
    completedDate: "2026-07-29",
    completedInstances: [],
    completed: true
  };
  const settings = {
    detectCompletedTaskExp: true,
    completionExpBaselineReady: true,
    completionExpSeen: {},
    autoAwardCompletedTaskExp: false,
    autoScoreCompletedTaskExp: false,
    autoExpSpendCapUsd: 0.1
  };
  let saved: ExpCompletionProposal | null = null;
  const coordinator = new ExpCompletionCoordinator(
    {
      list: async () => [task],
      get: async () => task,
      inspectSensitivity: async () => ({ sensitive: false, reasons: [] })
    } as unknown as TaskService,
    {
      taskState: async () => null,
      hasCompletion: async () => false,
      latestEvent: async () => null
    } as unknown as ExpService,
    {
      proposeAward: async () => { throw new Error("automatic scoring is disabled"); }
    } as unknown as ExpAutoScorer,
    {
      list: async () => saved ? [saved] : [],
      getByCompletion: async () => saved,
      save: async (proposal: ExpCompletionProposal) => {
        saved = proposal;
        return proposal;
      },
      remove: async () => undefined,
      renameTask: async () => undefined
    } as never,
    () => settings,
    async () => undefined,
    () => undefined,
    () => undefined
  );
  const result = await coordinator.reconcileAll();
  assert.equal(result.needsScore, 1);
  assert.equal(saved?.state, "needs-score");
});

test("EXP streaks count unique award days and allow yesterday's streak to remain current", () => {
  const entries = [
    { action: "award" as const, recordedAt: "2026-07-24T09:00:00+07:00" },
    { action: "award" as const, recordedAt: "2026-07-25T09:00:00+07:00" },
    { action: "plan" as const, recordedAt: "2026-07-26T09:00:00+07:00" },
    { action: "award" as const, recordedAt: "2026-07-27T09:00:00+07:00" },
    { action: "award" as const, recordedAt: "2026-07-27T18:00:00+07:00" }
  ];
  assert.deepEqual(
    calculateExpStreaks(entries, new Date("2026-07-28T08:00:00+07:00")),
    { current: 1, longest: 2 }
  );
});
