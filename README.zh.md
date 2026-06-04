# @ai0x0/codex-ts

轻量级 TypeScript agent harness，完全照搬 [openai/codex](https://github.com/openai/codex) Rust 实现（`codex-rs`）的架构设计，可在**浏览器**和 **Node.js** 中直接运行，无任何原生依赖。

本仓库 fork 自 [`openai/codex@6bcccb0e`](https://github.com/openai/codex/commit/6bcccb0ee)，新增代码全部在 `codex-ts/` 目录，不修改上游文件。

---

## 特点

- **浏览器原生** — 仅使用标准 `fetch` / `ReadableStream`，零 polyfill，零运行时依赖
- **照搬 codex-rs 设计** — 目录结构、类型命名、API（`submit` / `nextEvent`）与 Rust 版本一一对应
- **自动上下文压缩** — 照搬 codex-rs compact.rs：BodyAfterPrefix 模式追踪 token 增长，达到阈值时自动摘要历史，保证模型不超出上下文窗口
- **可注入持久化** — `ThreadStore` / `IoBackend` / `GoalStore` 均可替换，Node.js 写文件、浏览器用 OPFS 或 IndexedDB，接口不变
- **基础指令 + 技能** — 从 codex-rs core-skills 照搬的两层技能注入（目录 + `$mention`）和 agent harness 基础指令
- **可扩展工具** — 实现 `CustomTool` 接口注入即可，`ToolRouter`、SSE 解析、历史管理、事件队列已就绪
- **多轮对话** — `CodexThread` 自动维护对话历史，通过 `IoBackend` 跨页面刷新持久化和恢复

---

## 安装

```bash
npm install @ai0x0/codex-ts
# or
pnpm add @ai0x0/codex-ts
```

---

## 快速开始

```ts
import { CodexThread } from "@ai0x0/codex-ts";

const thread = new CodexThread({
  apiKey: "sk-...",
  model: "gpt-4o",
  instructions: "你是一个助手。",
});

await thread.submit({
  type: "UserInput",
  items: [{ type: "text", text: "帮我写一首诗" }],
});

for (;;) {
  const { msg } = await thread.nextEvent();
  if (msg.type === "AgentMessageContentDelta") process.stdout.write(msg.event.delta);
  if (msg.type === "TurnComplete") break;
}
```

---

## API

### `CodexThread`

照搬 `codex-rs/core/src/codex_thread.rs` 的公开接口。

```ts
const thread = new CodexThread({
  apiKey: string;
  model: string;
  baseUrl?: string;          // 默认 https://api.openai.com/v1
  instructions?: string;     // 开发者指令（追加在 base harness 之后）
  threadId?: string;         // 省略则自动生成；传入已有 ID 可 resume
  threadStore?: ThreadStore; // 自定义持久化存储（见下文）
  ioBackend?: IoBackend;     // I/O 原语注入（简写）
  goalStore?: GoalStore;     // goal 持久化存储
  customTools?: CustomTool[]; // host 注入的工具（见"自定义扩展工具"）
  baseInstructions?: string;  // 在 instructions 之前注入；默认 DEFAULT_BASE_INSTRUCTIONS；传 "" 可禁用
  skills?: SkillMetadata[];   // 已发现的技能列表，用于生成常驻目录（Layer 1）
  loadSkillContent?: (skill: SkillMetadata) => Promise<string>; // 按需加载 SKILL.md 全文（Layer 2）
  autoCompactTokenLimit?: number;  // 内联自动压缩的 token 阈值（推荐：context_window × 0.9）
});
```

#### `submit(op: Op): Promise<string>`

提交操作，返回 `submission_id`。对应 Rust 的 `pub async fn submit(&self, op: Op) -> CodexResult<String>`。

| `op.type` | 说明 |
|---|---|
| `UserInput` | 发送用户消息，触发新一轮。可选 `model` / `instructions` 字段覆盖本轮的线程级默认值 |
| `UserInputAnswer` | 回答 `request_user_input`，`id` = `RequestUserInputEvent.turn_id` |
| `Interrupt` | 中断当前正在执行的轮次（通过 `AbortController` 取消挂起的 `fetch`） |

#### `nextEvent(): Promise<Event>`

拉取下一个事件，阻塞直到可用。对应 Rust 的 `pub async fn next_event(&self) -> CodexResult<Event>`。

```ts
interface Event {
  id: string;   // submission_id
  msg: EventMsg;
}
```

---

## 支持的事件（EventMsg）

| `msg.type` | 说明 |
|---|---|
| `TurnStarted` | 新一轮开始 |
| `TurnComplete` | 本轮结束，含最终回复 |
| `AgentMessage` | 模型完整消息 |
| `AgentMessageContentDelta` | 流式文字片段 |
| `RequestUserInput` | 模型提问，需提交 `UserInputAnswer` 恢复 |
| `ThreadGoalUpdated` | goal 状态变更 |
| `PlanUpdate` | 任务清单更新，含步骤列表和各步骤状态 |
| `ContextCompacted` | 内联压缩已执行，历史已替换为摘要 |
| `Warning` | 建议信息（如压缩后的线程卫生提醒） |
| `Error` | 执行出错 |

---

## 已实现的工具

### `get_goal` / `create_goal` / `update_goal`

长任务目标追踪。照搬 `codex-rs/ext/goal/src/spec.rs` 的 JSON schema 和 `tool.rs` 的执行逻辑。

```ts
const thread = new CodexThread({
  apiKey: "sk-...",
  model: "gpt-4o",
  instructions: "接到复杂任务时先调用 create_goal 设定目标，完成后调用 update_goal 标记 complete。",
});

for (;;) {
  const { msg } = await thread.nextEvent();
  if (msg.type === "ThreadGoalUpdated") {
    console.log(msg.event.goal.status, msg.event.goal.objective);
  }
  if (msg.type === "TurnComplete") break;
}
```

### `request_user_input`

模型向用户提问并等待回答。照搬 `codex-rs/core/src/tools/handlers/request_user_input_spec.rs`。

```ts
await thread.submit({
  type: "UserInput",
  items: [{ type: "text", text: "帮我部署应用" }],
});

for (;;) {
  const { msg } = await thread.nextEvent();

  if (msg.type === "RequestUserInput") {
    const { turn_id, questions } = msg.event;
    // 用 turn_id 回答（对应 Rust Op::UserInputAnswer { id: request.turn_id }）
    await thread.submit({
      type: "UserInputAnswer",
      id: turn_id,
      response: {
        answers: { [questions[0]!.id]: { answers: ["生产环境"] } },
      },
    });
  }

  if (msg.type === "TurnComplete") break;
}
```

### `update_plan`

模型向客户端推送任务清单进度。照搬 `codex-rs/core/src/tools/handlers/plan_spec.rs` 的 schema 和 `plan.rs` 的处理逻辑。

```ts
for (;;) {
  const { msg } = await thread.nextEvent();

  if (msg.type === "PlanUpdate") {
    if (msg.event.explanation) console.log(msg.event.explanation);
    for (const item of msg.event.plan) {
      // item.status: "pending" | "in_progress" | "completed"
      console.log(`[${item.status}] ${item.step}`);
    }
  }

  if (msg.type === "TurnComplete") break;
}
```

---

## 持久化

照搬 `codex-rs` 两层持久化设计：

- **第一层（JSONL Rollout）** — 对话历史逐条追加，对应 Rust 的 `RolloutRecorder` + `.jsonl` 文件
- **第二层（状态数据库）** — goal 等元数据，对应 Rust 的 `codex-state` SQLite

### 可注入接口

**`IoBackend`** — 最轻量的注入点，只需实现 4 个 I/O 原语：

```ts
interface IoBackend {
  appendLine(threadId: string, line: string): Promise<void>;
  readLines(threadId: string): Promise<string[]>;
  listThreadIds(): Promise<string[]>;
  deleteThread(threadId: string): Promise<void>;
}
```

**`ThreadStore`** — 完整存储接口，照搬 `codex-rs/thread-store/src/store.rs` 的 `ThreadStore` trait：

```ts
interface ThreadStore {
  createThread(params): Promise<void>;
  appendItems(params): Promise<void>;
  loadHistory(params): Promise<StoredThreadHistory>;
  readThread(params): Promise<StoredThread | null>;
  updateThreadMetadata(params): Promise<void>;
  listThreadIds(): Promise<string[]>;
}
```

**`GoalBackend`** — goal 持久化原语，照搬 `codex-rs/state/src/runtime/goals.rs`：

```ts
interface GoalBackend {
  getThreadGoal(threadId: string): Promise<ThreadGoal | null>;
  saveThreadGoal(threadId: string, goal: ThreadGoal): Promise<void>;
  deleteThreadGoal(threadId: string): Promise<void>;
}
```

### 内置实现

| 类 | 用途 |
|---|---|
| `InMemoryThreadStore` | 无持久化，适合测试和临时会话 |
| `InMemoryIoBackend` | 内存版 I/O，用于开发和测试 |
| `LocalThreadStore` | 包装任意 `IoBackend` → 完整 `ThreadStore` |
| `InMemoryGoalBackend` | 内存版 goal 存储（默认） |

### Node.js 文件系统

```ts
import fs from "node:fs/promises";
import path from "node:path";

const fsBackend: IoBackend = {
  async appendLine(threadId, line) {
    await fs.mkdir(".codex", { recursive: true });
    await fs.appendFile(path.join(".codex", `${threadId}.jsonl`), line + "\n");
  },
  async readLines(threadId) {
    const text = await fs.readFile(path.join(".codex", `${threadId}.jsonl`), "utf8").catch(() => "");
    return text.split("\n").filter(Boolean);
  },
  async listThreadIds() {
    const files = await fs.readdir(".codex").catch(() => [] as string[]);
    return files.filter(f => f.endsWith(".jsonl")).map(f => f.slice(0, -6));
  },
  async deleteThread(threadId) {
    await fs.rm(path.join(".codex", `${threadId}.jsonl`), { force: true });
  },
};

const thread = new CodexThread({ apiKey, model, ioBackend: fsBackend });
```

### 浏览器（IndexedDB — 内置）

`IndexedDBIoBackend` 已内置，开箱即用：

```ts
import { CodexThread, IndexedDBIoBackend } from "@ai0x0/codex-ts";

const thread = new CodexThread({
  apiKey, model,
  ioBackend: new IndexedDBIoBackend(), // 自动持久化到 IndexedDB
});
```

### 浏览器（OPFS — 手动实现）

如需更高吞吐量，可自行实现 OPFS 版本：

```ts
const opfsBackend: IoBackend = {
  async appendLine(threadId, line) {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(`${threadId}.jsonl`, { create: true });
    const writable = await fh.createWritable({ keepExistingData: true });
    await writable.seek((await fh.getFile()).size);
    await writable.write(line + "\n");
    await writable.close();
  },
  async readLines(threadId) {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(`${threadId}.jsonl`).catch(() => null);
    if (!fh) return [];
    const text = await (await fh.getFile()).text();
    return text.split("\n").filter(Boolean);
  },
  async listThreadIds() {
    const root = await navigator.storage.getDirectory();
    const ids: string[] = [];
    for await (const [name] of (root as any).entries()) {
      if (name.endsWith(".jsonl")) ids.push(name.slice(0, -6));
    }
    return ids;
  },
  async deleteThread(threadId) {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(`${threadId}.jsonl`).catch(() => {});
  },
};

const thread = new CodexThread({ apiKey, model, ioBackend: opfsBackend });
```

### 持久化 goal（IndexedDB 示例）

```ts
import { GoalStore, GoalBackend } from "@ai0x0/codex-ts";

const idbGoalBackend: GoalBackend = {
  async getThreadGoal(threadId) { /* idb.get(threadId) */ },
  async saveThreadGoal(threadId, goal) { /* idb.put(threadId, goal) */ },
  async deleteThreadGoal(threadId) { /* idb.delete(threadId) */ },
};

const thread = new CodexThread({
  apiKey, model,
  ioBackend: opfsBackend,
  goalStore: new GoalStore(idbGoalBackend),
});
```

### Resume 已有对话

新线程用 `new CodexThread()`，resume 用 `await CodexThread.create()` — 它会在开始前从 store 加载历史。

```ts
// 第一次对话
const thread = new CodexThread({ apiKey, model, ioBackend: fsBackend });
const threadId = thread.id;   // 保存这个 ID

await thread.submit({ type: "UserInput", items: [{ type: "text", text: "你好" }] });
for (;;) {
  const { msg } = await thread.nextEvent();
  if (msg.type === "TurnComplete") break;
}

// 进程重启后 resume —— 用 create() 而不是 new
const resumed = await CodexThread.create({
  apiKey, model,
  threadId,                   // 传入之前的 ID
  ioBackend: fsBackend,       // 同一个 backend
});
// 历史已从 backend 加载，再 submit 时模型能看到完整上下文
await resumed.submit({ type: "UserInput", items: [{ type: "text", text: "继续" }] });
```

---

## 上下文自动压缩

照搬 `codex-rs/core/src/compact.rs`。当上下文增长超过 `autoCompactTokenLimit` 时，agent 自动用一次独立请求总结历史并替换 history，让模型在不失去任务连续性的情况下保持在上下文窗口内。

**算法（BodyAfterPrefix 模式，与 codex-rs 默认一致）：**

1. 每次 sampling 结束从 `response.done` 取 `input_tokens`
2. 第一次采样设定基线；后续采样测量增量：`scope_tokens = current − baseline`
3. 当 `scope_tokens ≥ autoCompactTokenLimit` 且**还有工具调用需要继续执行**时触发压缩：
   - 发一条独立请求：完整历史 + `SUMMARIZATION_PROMPT`，取模型返回的摘要
   - 摘要前置 `SUMMARY_PREFIX`，作为最后一条用户消息
   - 最近 20 000 token 以内的用户消息拼在摘要之前
   - 原地替换 `history`，发出 `ContextCompacted` + `Warning` 事件
   - 重置 token 基线，进入新窗口

```ts
// 推荐值：context_window × 0.9
// gpt-4o 128k 上下文 → ~115 000
const thread = new CodexThread({
  apiKey: "sk-...",
  model: "gpt-4o",
  autoCompactTokenLimit: 115_000,
});

for (;;) {
  const { msg } = await thread.nextEvent();
  if (msg.type === "ContextCompacted") {
    console.log("历史已压缩，继续执行…");
  }
  if (msg.type === "TurnComplete") break;
}
```

不传 `autoCompactTokenLimit` 则完全禁用压缩。

---

## 在浏览器中使用（React 示例）

```tsx
import { useRef, useState, useCallback } from "react";
import { CodexThread } from "@ai0x0/codex-ts";
import type { RequestUserInputEvent } from "@ai0x0/codex-ts";

export function Chat() {
  const threadRef = useRef<CodexThread | null>(null);
  const [output, setOutput]   = useState("");
  const [pending, setPending] = useState<RequestUserInputEvent | null>(null);

  function getThread() {
    threadRef.current ??= new CodexThread({
      apiKey: import.meta.env.VITE_API_KEY,
      model: "gpt-4o",
    });
    return threadRef.current;
  }

  const send = useCallback(async (text: string) => {
    const thread = getThread();
    setOutput("");
    await thread.submit({ type: "UserInput", items: [{ type: "text", text }] });
    for (;;) {
      const { msg } = await thread.nextEvent();
      if (msg.type === "AgentMessageContentDelta") setOutput(p => p + msg.event.delta);
      if (msg.type === "RequestUserInput")         setPending(msg.event);
      if (msg.type === "TurnComplete")             break;
    }
    setPending(null);
  }, []);

  const answer = useCallback((event: RequestUserInputEvent, value: string) => {
    void getThread().submit({
      type: "UserInputAnswer",
      id: event.turn_id,
      response: { answers: { [event.questions[0]!.id]: { answers: [value] } } },
    });
    setPending(null);
  }, []);

  return (
    <div>
      <button onClick={() => send("帮我规划今天的工作")}>发送</button>
      <pre>{output}</pre>
      {pending && (
        <div>
          <p>{pending.questions[0]?.question}</p>
          {pending.questions[0]?.options?.map(opt => (
            <button key={opt.label} onClick={() => answer(pending, opt.label)}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## 基础指令与技能

### 基础指令（Base Instructions）

照搬 codex-rs 的 `base_instructions/default.md` agent harness。每轮对话都会把它前置在 `instructions` 之前，确保模型表现得像一个工具调用 agent。默认值（`DEFAULT_BASE_INSTRUCTIONS`）是移除了编码专属内容的浏览器适配版本。

```ts
import { CodexThread, DEFAULT_BASE_INSTRUCTIONS } from "@ai0x0/codex-ts";

// 使用默认（推荐）
const thread = new CodexThread({ apiKey, model });

// 在默认 harness 后追加自定义内容
const thread2 = new CodexThread({
  apiKey, model,
  baseInstructions: DEFAULT_BASE_INSTRUCTIONS + "\n\n请始终用中文回复。",
});

// 完全禁用（模型只收到 instructions）
const thread3 = new CodexThread({ apiKey, model, baseInstructions: "" });
```

### 技能（Skills）

照搬 `codex-rs/core-skills/` 的两层技能注入机制。文件系统扫描由 host 负责（浏览器无法读取目录），codex-ts 负责渲染和注入。

**Layer 1 — 常驻目录**（照搬 `render.rs`）：把所有技能的名称、描述、路径渲染为 `## Skills` 章节，拼接在每轮 `instructions` 末尾，让模型始终知道有哪些技能可用。

**Layer 2 — 全文注入**（照搬 `injection.rs`）：用户消息中出现 `$skill-name` 时，通过 `loadSkillContent` 加载对应 `SKILL.md` 全文，以 `<skill>` 块的形式注入当轮输入的最前面。技能全文**不写入历史**——仅对当轮有效。

```ts
import { CodexThread } from "@ai0x0/codex-ts";
import type { SkillMetadata } from "@ai0x0/codex-ts";

// host 扫描技能目录（例如 .agents/skills/）
const skills: SkillMetadata[] = [
  { name: "song-analyzer", description: "分析一首歌曲。", path: ".agents/skills/song-analyzer/SKILL.md" },
];

const thread = new CodexThread({
  apiKey, model,
  skills,
  // host 提供读取器（浏览器用 fetch，Node.js 用 fs.readFile）
  loadSkillContent: async (skill) => {
    const res = await fetch(skill.path);
    return res.text();
  },
});

// 用户用 $skill-name 触发全文注入
await thread.submit({
  type: "UserInput",
  items: [{ type: "text", text: "用 $song-analyzer 分析这首曲子" }],
});
```

---

## 自定义扩展工具

实现 `CustomTool` 接口，在构造 `CodexThread` 时注入，无需修改 `router.ts`：

```ts
import { CodexThread } from "@ai0x0/codex-ts";
import type { CustomTool, CustomToolContext } from "@ai0x0/codex-ts";
import * as S from "@ai0x0/codex-ts/tools";

const searchTool: CustomTool = {
  name: "web_search",
  spec() {
    return {
      type: "function",
      tool: {
        name: "web_search",
        description: "搜索网络。",
        parameters: S.object({ query: S.string("搜索词") }, ["query"], false),
        strict: false,
      },
    };
  },
  async execute(args: unknown, ctx: CustomToolContext) {
    const { query } = args as { query: string };
    const results = await mySearchAPI(query);
    return JSON.stringify(results);
  },
};

const thread = new CodexThread({
  apiKey: "sk-...",
  model: "gpt-4o",
  customTools: [searchTool],
});
```

`CustomToolContext` 提供 `callId`、`turnId` 和 `emitEvent`，供需要发送中间事件的工具使用。

如果工具是项目内置的，也可以直接在 `core/src/tools/router.ts` 的 `dispatch` 加 `case`（参考 `update_plan` 的写法）。

---

## 项目结构

完全照搬 `codex-rs` 的 crate 层级，目录名与 Rust 侧一一对应：

```
codex-ts/
├── protocol/src/                    ← codex-rs/protocol/src/
│   ├── protocol.ts                  ←   protocol.rs        (EventMsg, Op, Event)
│   ├── user_input.ts                ←   user_input.rs
│   └── request_user_input.ts        ←   request_user_input.rs
│
├── tools/src/                       ← codex-rs/tools/src/
│   ├── tool_spec.ts                 ←   tool_spec.rs       (ToolSpec)
│   └── json_schema.ts               ←   json_schema helpers
│
├── ext/goal/src/                    ← codex-rs/ext/goal/src/
│   ├── spec.ts                      ←   spec.rs            (goal tool schemas)
│   └── tool.ts                      ←   tool.rs            (GoalToolExecutor)
│
├── thread-store/src/                ← codex-rs/thread-store/src/
│   ├── store.ts                     ←   store.rs           (ThreadStore interface)
│   ├── types.ts                     ←   types.rs           (RolloutItem, StoredThread…)
│   ├── in_memory.ts                 ←   in_memory.rs       (InMemoryThreadStore)
│   ├── live_thread.ts               ←   live_thread.rs     (LiveThread)
│   ├── local_thread_store.ts        ←   local/             (IoBackend → ThreadStore)
│   ├── io_backend.ts                ←   [浏览器扩展]       (IoBackend 可注入接口)
│   └── indexeddb.ts                 ←   [浏览器扩展]       (IndexedDB 内置实现)
│
├── state/src/runtime/               ← codex-rs/state/src/runtime/
│   └── goals.ts                     ←   goals.rs           (GoalStore + GoalBackend)
│
└── core/
    ├── src/
    │   ├── codex_thread.ts          ←   codex_thread.rs    (submit / nextEvent)
    │   ├── session/turn.ts          ←   session/turn.rs    (runTurn + SSE 解析)
    │   └── tools/
    │       ├── router.ts            ←   tools/router.rs
    │       └── handlers/
    │           ├── request_user_input_spec.ts
    │           ├── request_user_input.ts
    │           ├── plan_spec.ts             ←   handlers/plan_spec.rs
    │           └── plan.ts (via router)     ←   handlers/plan.rs
    └── tests/
        ├── common/lib.ts            ←   core/tests/common/lib.rs  (waitForEvent…)
        └── suite/
            ├── goal.test.ts                    ←   tool_harness.rs (goal 部分)
            ├── plan.test.ts                    ←   tool_harness.rs (plan 部分)
            ├── request_user_input.test.ts      ←   request_user_input.rs
            ├── resume.test.ts                  ←   resume.rs
            └── extensions.test.ts              ←   [浏览器扩展]  (CustomTool, Interrupt)
```

---

## 与上游同步

本仓库仅新增 `codex-ts/` 目录，对上游文件的唯一改动是 `pnpm-workspace.yaml` 追加一行 `- codex-ts`。

### codex-ts 参照版本

`codex-ts/` 的所有实现均对照 codex-rs 在以下提交时的源码逐一照搬：

**[`6bcccb0e`](https://github.com/openai/codex/commit/6bcccb0ee) — cli: add package path from install context (#26189)**

以后同步上游时，以这个哈希为起点与新版本做 diff，确认哪些 Rust 侧变更需要同步到 codex-ts 的对应 `.ts` 文件：

```bash
# 查看上游在参照提交之后的变更
git diff 6bcccb0e HEAD -- codex-rs/protocol/src/protocol.rs
git diff 6bcccb0e HEAD -- codex-rs/ext/goal/src/spec.rs
# 依此类推对照上方映射表逐文件检查
```

同步完成后将上方哈希替换为新的参照提交。

### 源码注释约定

每个 `.ts` 文件都通过注释标明了与 codex-rs 的关系，同步上游时按此决定是否需要处理：

| 注释 | 含义 | 上游有 diff 时的操作 |
|---|---|---|
| `// mirrors codex-rs/path/to/file.rs` | 直接照搬的 TypeScript 翻译 | **检查 diff**，大概率需要同步 |
| `// mirrors: …`（行内） | 该字段/模式是特定 Rust 构造的 TS 等价物 | 确认对应的 Rust 构造是否变化 |
| `// Browser-specific extension — no equivalent in codex-rs` | mirror 层之上新增的浏览器扩展，Rust 无对应实现 | **跳过**，上游变更不影响这里 |
| `// Browser-specific adaptation of …` | 有意裁剪的适配（如 `Op.UserInput` vs `ThreadSettingsOverrides`） | 扫一眼 diff，看是否有值得补充的新字段 |

### 同步流程

```bash
# 添加上游源（仅首次）
git remote add upstream git@github.com:openai/codex.git

# 拉取并 rebase
git fetch upstream
git rebase upstream/main

# 如有冲突，仅 pnpm-workspace.yaml 需手动保留 codex-ts 这一行
```

当上游 `codex-rs` 有变更时，按对应关系更新 `codex-ts` 的镜像文件：

| 上游变更 | 需更新的 codex-ts 文件 |
|---|---|
| `protocol/src/protocol.rs` — 新增 EventMsg 变体 | `protocol/src/protocol.ts` |
| `ext/goal/src/spec.rs` — schema 调整 | `ext/goal/src/spec.ts` |
| `request_user_input_spec.rs` — 字段变更 | `core/src/tools/handlers/request_user_input_spec.ts` |
| `plan_spec.rs` / `plan_tool.rs` — schema 变更 | `core/src/tools/handlers/plan_spec.ts` + `protocol/src/plan_tool.ts` |
| `thread-store/src/store.rs` — 接口变更 | `thread-store/src/store.ts` |
| `state/src/runtime/goals.rs` — accounting 逻辑变更 | `state/src/runtime/goals.ts` |
| 新增工具 | `core/src/tools/router.ts` |

---

## 运行测试

```bash
pnpm -F "@ai0x0/codex-ts" test
```

测试结构照搬 `codex-rs/core/tests/suite/`，使用 mock fetch 模拟 Responses API SSE 流，无需真实 API Key。
