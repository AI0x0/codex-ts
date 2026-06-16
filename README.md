# @ai0x0/codex-ts

A lightweight TypeScript agent harness that mirrors the architecture of [openai/codex](https://github.com/openai/codex) (`codex-rs`) — runs in the **browser** and **Node.js** with zero native dependencies.

Forked from [`openai/codex@6bcccb0e`](https://github.com/openai/codex/commit/6bcccb0ee). All new code lives in `codex-ts/`; upstream files are untouched.

[中文文档](./README.zh.md)

---

## Features

- **Browser-native** — uses only standard `fetch` / `ReadableStream`, zero polyfills, zero runtime dependencies
- **Mirrors codex-rs** — directory layout, type names, and API (`submit` / `nextEvent`) match the Rust implementation one-to-one
- **Auto-compaction** — context window management mirrors codex-rs: BodyAfterPrefix token tracking triggers inline summarisation before the model hits its limit
- **Injectable persistence** — `ThreadStore` / `IoBackend` / `GoalStore` are all replaceable; Node.js writes files, browser uses OPFS or IndexedDB — same interface either way
- **Base instructions + skills** — agent harness and two-layer skill injection (catalog + `$mention`) ported from codex-rs core-skills
- **Extensible tools** — add a new tool by implementing `CustomTool` and passing it to `CodexThread`; `ToolRouter`, SSE parsing, history, and the event queue are already wired up
- **Multi-turn conversation** — `CodexThread` maintains conversation history and resumes across page reloads via `IoBackend`

---

## Installation

```bash
npm install @ai0x0/codex-ts
# or
pnpm add @ai0x0/codex-ts
```

---

## Quick start

```ts
import { CodexThread } from "@ai0x0/codex-ts";

const thread = new CodexThread({
  apiKey: "sk-...",
  model: "gpt-4o",
  instructions: "You are a helpful assistant.",
});

await thread.submit({
  type: "UserInput",
  items: [{ type: "text", text: "Write me a poem" }],
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

Mirrors `codex-rs/core/src/codex_thread.rs`.

```ts
const thread = new CodexThread({
  apiKey: string;
  model: string;
  baseUrl?: string;          // default: https://api.openai.com/v1
  fetch?: typeof fetch;      // custom fetch for Responses API calls; default: global fetch (use to inject auth headers / token refresh)
  instructions?: string;     // developer instructions (appended after base harness)
  threadId?: string;         // omit to generate; supply to resume
  threadStore?: ThreadStore; // custom persistence store
  ioBackend?: IoBackend;     // I/O primitives shorthand
  goalStore?: GoalStore;     // goal persistence store
  customTools?: CustomTool[]; // host-supplied tools (see "Adding a custom tool")
  baseInstructions?: string;  // prepended before instructions; defaults to DEFAULT_BASE_INSTRUCTIONS; pass "" to disable
  skills?: SkillMetadata[];   // discovered skills for the always-on catalog (Layer 1)
  loadSkillContent?: (skill: SkillMetadata) => Promise<string>; // full-body loader for $mention injection (Layer 2)
  agentsMd?: string;           // AGENTS.md content injected as a discrete input message (not merged into instructions)
  autoCompactTokenLimit?: number;  // token threshold for inline auto-compaction (e.g. context_window × 0.9)
});
```

#### `submit(op: Op): Promise<string>`

Submit an operation; returns `submission_id`. Mirrors `pub async fn submit(&self, op: Op) -> CodexResult<String>`.

| `op.type` | Description |
|---|---|
| `UserInput` | Send a user message, starts a new turn. Optional `model` and `instructions` fields override the thread-level defaults for this turn only |
| `UserInputAnswer` | Answer a `request_user_input` call; `id` = `RequestUserInputEvent.turn_id` |
| `Interrupt` | Abort the in-flight turn (cancels the pending `fetch` via `AbortController`) |

#### `nextEvent(): Promise<Event>`

Pull the next event; blocks until one is available. Mirrors `pub async fn next_event(&self) -> CodexResult<Event>`.

```ts
interface Event {
  id: string;   // submission_id
  msg: EventMsg;
}
```

#### `CodexThread.create(config): Promise<CodexThread>`

Async factory — use instead of `new` when resuming an existing thread. Loads conversation history from the store before the first turn.

---

## Events (EventMsg)

| `msg.type` | Description |
|---|---|
| `TurnStarted` | A new turn has begun |
| `TurnComplete` | Turn finished; contains the final reply |
| `AgentMessage` | Complete assistant message |
| `AgentMessageContentDelta` | Streaming text chunk |
| `RequestUserInput` | Model is asking the user; submit `UserInputAnswer` to resume |
| `ThreadGoalUpdated` | Goal state changed |
| `PlanUpdate` | Task checklist updated with step list and statuses |
| `ContextCompacted` | Inline compaction ran; history has been replaced with a summary |
| `Warning` | Advisory (e.g. post-compaction thread hygiene reminder) |
| `Error` | Execution error |

---

## Implemented tools

### `get_goal` / `create_goal` / `update_goal`

Long-running task goal tracking. Mirrors `codex-rs/ext/goal/src/spec.rs` (schema) and `tool.rs` (executor).

```ts
const thread = new CodexThread({
  apiKey: "sk-...",
  model: "gpt-4o",
  instructions:
    "When given a complex task, call create_goal first. " +
    "When done, call update_goal with status complete.",
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

Model asks the user one to three questions and waits for the answer. Mirrors `codex-rs/core/src/tools/handlers/request_user_input_spec.rs`.

```ts
await thread.submit({
  type: "UserInput",
  items: [{ type: "text", text: "Deploy the app" }],
});

for (;;) {
  const { msg } = await thread.nextEvent();

  if (msg.type === "RequestUserInput") {
    const { turn_id, questions } = msg.event;
    // mirrors Op::UserInputAnswer { id: request.turn_id, ... }
    await thread.submit({
      type: "UserInputAnswer",
      id: turn_id,
      response: {
        answers: { [questions[0]!.id]: { answers: ["production"] } },
      },
    });
  }

  if (msg.type === "TurnComplete") break;
}
```

### `update_plan`

Model pushes a task checklist with step-level status. Mirrors `codex-rs/core/src/tools/handlers/plan_spec.rs`.

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

## Persistence

Mirrors the two-layer persistence design of codex-rs:

- **Layer 1 (JSONL rollout)** — conversation items appended line by line; mirrors `RolloutRecorder` + `.jsonl` files
- **Layer 2 (state store)** — goal metadata; mirrors `codex-state` SQLite

### Injectable interfaces

**`IoBackend`** — the minimal I/O primitive; implement just four methods:

```ts
interface IoBackend {
  appendLine(threadId: string, line: string): Promise<void>;
  readLines(threadId: string): Promise<string[]>;
  listThreadIds(): Promise<string[]>;
  deleteThread(threadId: string): Promise<void>;
}
```

**`ThreadStore`** — full storage interface, mirrors `codex-rs/thread-store/src/store.rs`:

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

**`GoalBackend`** — goal persistence primitive, mirrors `codex-rs/state/src/runtime/goals.rs`:

```ts
interface GoalBackend {
  getThreadGoal(threadId: string): Promise<ThreadGoal | null>;
  saveThreadGoal(threadId: string, goal: ThreadGoal): Promise<void>;
  deleteThreadGoal(threadId: string): Promise<void>;
}
```

### Built-in implementations

| Class | Use |
|---|---|
| `InMemoryThreadStore` | No persistence; good for tests and ephemeral sessions |
| `InMemoryIoBackend` | In-memory I/O; development and testing |
| `LocalThreadStore` | Wraps any `IoBackend` into a full `ThreadStore` |
| `InMemoryGoalBackend` | In-memory goal store (default) |

### Node.js filesystem

```ts
import fs from "node:fs/promises";
import path from "node:path";

const fsBackend: IoBackend = {
  async appendLine(threadId, line) {
    await fs.mkdir(".codex", { recursive: true });
    await fs.appendFile(path.join(".codex", `${threadId}.jsonl`), line + "\n");
  },
  async readLines(threadId) {
    const text = await fs.readFile(
      path.join(".codex", `${threadId}.jsonl`), "utf8"
    ).catch(() => "");
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

### Browser (IndexedDB — built-in)

`IndexedDBIoBackend` is included and requires no configuration:

```ts
import { CodexThread, IndexedDBIoBackend } from "@ai0x0/codex-ts";

const thread = new CodexThread({
  apiKey, model,
  ioBackend: new IndexedDBIoBackend(), // persists to IndexedDB automatically
});
```

### Browser (OPFS — manual)

If you prefer OPFS (Origin Private File System) for higher throughput:

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
    return (await (await fh.getFile()).text()).split("\n").filter(Boolean);
  },
  async listThreadIds() {
    const root = await navigator.storage.getDirectory();
    const ids: string[] = [];
    for await (const [name] of (root as any).entries())
      if (name.endsWith(".jsonl")) ids.push(name.slice(0, -6));
    return ids;
  },
  async deleteThread(threadId) {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(`${threadId}.jsonl`).catch(() => {});
  },
};

const thread = new CodexThread({ apiKey, model, ioBackend: opfsBackend });
```

### Persistent goals (IndexedDB example)

```ts
import { GoalStore } from "@ai0x0/codex-ts";
import type { GoalBackend } from "@ai0x0/codex-ts";

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

### Resume an existing thread

Use `new CodexThread()` for new threads and `await CodexThread.create()` to resume — the factory method loads history from the store before the first turn.

```ts
// First session
const thread = new CodexThread({ apiKey, model, ioBackend: fsBackend });
const threadId = thread.id;  // save this

// Later — resume
const resumed = await CodexThread.create({
  apiKey, model,
  threadId,               // the saved ID
  ioBackend: fsBackend,   // same backend
});
// History is loaded; the model sees full context on the next submit
```

---

## Context compaction

Mirrors `codex-rs/core/src/compact.rs`. When the context grows past `autoCompactTokenLimit`, the agent automatically summarises its conversation history with a fresh model request and replaces the history with the summary — keeping the model within its context window without losing task continuity.

**Algorithm (BodyAfterPrefix mode, matching codex-rs default):**

1. Each sampling round records `input_tokens` from `response.done`
2. The first round in a window sets the baseline; subsequent rounds measure growth: `scope_tokens = current − baseline`
3. When `scope_tokens ≥ autoCompactTokenLimit` **and** tool calls remain (mid-turn), compaction fires:
   - A separate request sends the full history + `SUMMARIZATION_PROMPT` to the model
   - The summary is prefixed with `SUMMARY_PREFIX` and stored as the last user message
   - Recent user messages (up to 20 000 tokens) are prepended before the summary
   - History is replaced in-place; `ContextCompacted` + `Warning` events are emitted
   - The token baseline resets for the next window (`startNext()`)

```ts
// Recommended value: 90% of the model's context window
// gpt-4o has a 128 k context → ~115 000
const thread = new CodexThread({
  apiKey: "sk-...",
  model: "gpt-4o",
  autoCompactTokenLimit: 115_000,
});

for (;;) {
  const { msg } = await thread.nextEvent();
  if (msg.type === "ContextCompacted") {
    console.log("History compacted — continuing…");
  }
  if (msg.type === "TurnComplete") break;
}
```

Omit `autoCompactTokenLimit` to disable compaction entirely.

---

## Browser usage (React example)

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
      <button onClick={() => send("Plan my day")}>Send</button>
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

## Base instructions and skills

### Base instructions

Mirrors the `base_instructions/default.md` agent harness in codex-rs. This is prepended ahead of `instructions` every turn to keep the model behaving as a tool-calling agent. The default (`DEFAULT_BASE_INSTRUCTIONS`) is a browser-adapted version with coding-specific content removed.

```ts
import { CodexThread, DEFAULT_BASE_INSTRUCTIONS } from "@ai0x0/codex-ts";

// Use the default (recommended)
const thread = new CodexThread({ apiKey, model });

// Append your own text to the default harness
const thread2 = new CodexThread({
  apiKey, model,
  baseInstructions: DEFAULT_BASE_INSTRUCTIONS + "\n\nAlways respond in French.",
});

// Disable entirely (model receives only `instructions`)
const thread3 = new CodexThread({ apiKey, model, baseInstructions: "" });
```

### Skills

Mirrors the two-layer skill injection in `codex-rs/core-skills/`. Filesystem discovery is the host's responsibility (the browser has no `readdir`); once found, skill metadata is passed in and codex-ts handles the rest.

**Layer 1 — always-on catalog** (mirrors `render.rs`): a `## Skills` section is injected every turn as a discrete `input` message (not baked into `instructions`), so the model sees it as a separate context boundary. Descriptions are budget-trimmed to fit within `SkillMetadataBudget` — defaulting to 2% of the model's context window in tokens (or 8 000 characters when the window is unknown). When the budget is exceeded, shorter descriptions or omission warnings are injected automatically, matching codex-rs behaviour exactly.

**Layer 2 — full-body injection** (mirrors `injection.rs`): when the user mentions `$skill-name`, the skill's full `SKILL.md` is loaded via `loadSkillContent` and prepended to that turn's input as a `<skill>` block. Skill bodies are **not** persisted to history — they are turn-scoped context only.

```ts
import { CodexThread } from "@ai0x0/codex-ts";
import type { SkillMetadata } from "@ai0x0/codex-ts";

// Host discovers skills (e.g. by scanning .agents/skills/)
const skills: SkillMetadata[] = [
  { name: "song-analyzer", description: "Analyze a song.", path: ".agents/skills/song-analyzer/SKILL.md" },
];

const thread = new CodexThread({
  apiKey, model,
  skills,
  // Host provides the reader (browser: fetch; Node.js: fs.readFile)
  loadSkillContent: async (skill) => {
    const res = await fetch(skill.path);
    return res.text();
  },
});

// User can trigger full-body injection with $skill-name
await thread.submit({
  type: "UserInput",
  items: [{ type: "text", text: "use $song-analyzer on this track" }],
});
```

### AGENTS.md (project documentation)

Mirrors `codex-rs/core/src/agents_md.rs` (UserInstructions fragment). Pass the content of your project's `AGENTS.md` as `agentsMd`; it is injected as a discrete `input` message ahead of the conversation history — **not** merged into the `instructions` field. This keeps developer instructions and project documentation as separate model-visible boundaries, matching codex-rs's contextual fragment architecture. Reading and selecting the file (e.g. preferring `AGENTS.override.md`) is the host's responsibility — the browser has no filesystem.

```ts
const thread = new CodexThread({
  apiKey, model,
  instructions: "You are a helpful assistant.",
  agentsMd: `## Project context\nThis is a music platform...`,
});
// What the model sees in `input` (before history):
//   { role: "user", content: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\n## Project context\n...\n</INSTRUCTIONS>" }
// `instructions` field contains only: base harness + "You are a helpful assistant."
```

When `agentsMd` is absent, no AGENTS.md message is injected. The `input` ordering mirrors codex-rs TurnContext: `agentsMd message → skills catalog message → $mention skill bodies → conversation history`.

---

## Adding a custom tool

Implement the `CustomTool` interface and pass it to `CodexThread`. No need to
touch `router.ts` — the tool is injected at construction time.

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
        description: "Search the web.",
        parameters: S.object({ query: S.string("Search query") }, ["query"], false),
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

`CustomToolContext` exposes `callId`, `turnId`, and `emitEvent` for tools that
need to emit side-effect events (e.g. streaming progress) before returning.

For project-internal tools that should be part of the built-in set, add a `case`
in `core/src/tools/router.ts` instead (same pattern as `update_plan`).

---

## Project layout

Directory names match the corresponding codex-rs crates:

```
codex-ts/
├── protocol/src/                    ← codex-rs/protocol/src/
│   ├── protocol.ts                  ←   protocol.rs        (EventMsg, Op, Event)
│   ├── user_input.ts                ←   user_input.rs
│   ├── request_user_input.ts        ←   request_user_input.rs
│   └── plan_tool.ts                 ←   plan_tool.rs       (StepStatus, UpdatePlanArgs)
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
│   ├── io_backend.ts                ←   [browser ext]      (injectable IoBackend interface)
│   └── indexeddb.ts                 ←   [browser ext]      (IndexedDB implementation)
│
├── state/src/runtime/               ← codex-rs/state/src/runtime/
│   └── goals.ts                     ←   goals.rs           (GoalStore + GoalBackend)
│
└── core/
    ├── src/
    │   ├── codex_thread.ts          ←   codex_thread.rs    (submit / nextEvent)
    │   ├── compact.ts               ←   compact.rs         (SUMMARIZATION_PROMPT, runInlineAutoCompactTask)
    │   ├── base_instructions.ts     ←   prompts/base_instructions/default.md
    │   ├── skills.ts                ←   core-skills/src/   (render + injection + skill_instructions)
    │   ├── state/
    │   │   └── auto_compact_window.ts ← state/auto_compact_window.rs
    │   ├── session/
    │   │   ├── turn.ts              ←   session/turn.rs    (runTurn + compaction trigger)
    │   │   └── sse.ts               ←   (shared SSE parser)
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
            ├── goal.test.ts                    ←   tool_harness.rs (goal)
            ├── plan.test.ts                    ←   tool_harness.rs (plan)
            ├── compact.test.ts                 ←   compact.rs tests
            ├── request_user_input.test.ts      ←   request_user_input.rs
            ├── resume.test.ts                  ←   resume.rs
            ├── skills.test.ts                  ←   core-skills tests
            └── extensions.test.ts              ←   [browser ext]  (CustomTool, Interrupt, baseInstructions)
```

---

## Keeping in sync with upstream

Only `codex-ts/` is added; the single upstream file change is one line appended to `pnpm-workspace.yaml`.

### Reference commit

All implementations in `codex-ts/` were written against codex-rs at:

**[`6bcccb0e`](https://github.com/openai/codex/commit/6bcccb0ee) — cli: add package path from install context (#26189)**

When syncing, diff from this hash to find what changed in the Rust source and update the corresponding `.ts` file:

```bash
# Check what changed in mirrored files
git diff 6bcccb0e HEAD -- codex-rs/protocol/src/protocol.rs
git diff 6bcccb0e HEAD -- codex-rs/ext/goal/src/spec.rs
# repeat for each file in the mapping table below
```

Update the hash above to the new reference commit after each sync.

### Source comment conventions

Every `.ts` file that has a non-trivial relationship with codex-rs is annotated
so you know at a glance whether a diff from upstream requires action:

| Comment in source | Meaning | Action on upstream diff |
|---|---|---|
| `// mirrors codex-rs/path/to/file.rs` | Direct TypeScript translation | **Check the diff** — likely needs updating |
| `// mirrors: …` (inline) | Specific field or pattern is the TS equivalent of a named Rust construct | Check if the Rust construct changed |
| `// Browser-specific extension — no equivalent in codex-rs` | Added on top of the mirror layer; Rust has nothing analogous | **Skip** — upstream changes don't affect this |
| `// Browser-specific adaptation of …` | Intentional simplification (e.g. `Op.UserInput` vs `ThreadSettingsOverrides`) | Skim the diff to see if new relevant fields should be ported |

### File mapping

| Upstream change | codex-ts file to update |
|---|---|
| `protocol/src/protocol.rs` — new EventMsg variant | `protocol/src/protocol.ts` |
| `ext/goal/src/spec.rs` — schema change | `ext/goal/src/spec.ts` |
| `request_user_input_spec.rs` — field change | `core/src/tools/handlers/request_user_input_spec.ts` |
| `plan_spec.rs` / `plan_tool.rs` — schema change | `core/src/tools/handlers/plan_spec.ts` + `protocol/src/plan_tool.ts` |
| `thread-store/src/store.rs` — interface change | `thread-store/src/store.ts` |
| `state/src/runtime/goals.rs` — accounting change | `state/src/runtime/goals.ts` |
| `compact.rs` — compaction logic change | `core/src/compact.ts` |
| `state/auto_compact_window.rs` — window tracking change | `core/src/state/auto_compact_window.ts` |
| `prompts/templates/compact/prompt.md` — summarisation prompt | `SUMMARIZATION_PROMPT` in `core/src/compact.ts` |
| New tool added | `core/src/tools/router.ts` |

### Sync workflow

```bash
# Add upstream remote (first time only)
git remote add upstream git@github.com:openai/codex.git

# Fetch and rebase
git fetch upstream
git rebase upstream/main

# The only conflict will be pnpm-workspace.yaml — keep the codex-ts line
```

---

## Tests

```bash
pnpm -F "@ai0x0/codex-ts" test
```

Test structure mirrors `codex-rs/core/tests/suite/`. All tests use a mocked `fetch` to simulate Responses API SSE streams — no real API key needed.
