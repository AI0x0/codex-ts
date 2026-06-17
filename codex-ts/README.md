# @ai0x0/codex-ts

A TypeScript port of the codex-rs agent core — runs the Codex sampling loop
(Responses API streaming + tool calls + auto-compaction) directly in Node or the
browser, with no spawned process.

```ts
import { CodexThread } from "@ai0x0/codex-ts";

const thread = new CodexThread({
  apiKey: "…",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.4",
});

const turnId = await thread.submit({
  type: "UserInput",
  items: [{ type: "text", text: "hello" }],
});

for (;;) {
  const { msg } = await thread.nextEvent();
  if (msg.type === "AgentMessage") console.log(msg.event.message);
  if (msg.type === "TurnComplete") break;
}
```

## Retries

Transient Responses failures are retried automatically with exponential
backoff — mirrors codex-rs's stream retry loop (`responses_retry.rs`).

A failure is **retried** when it happens **before any visible output has
streamed** and is transient:

- a network error (fetch rejects: connection reset, DNS, CORS-masked failure…);
- an HTTP `408`, `409`, `429`, or any `5xx` (e.g. a `502` during a deploy
  window);
- the SSE stream dropping before the first text delta.

A failure is **not retried** when:

- visible output has already streamed (a re-stream would duplicate text);
- the error is terminal — `4xx` other than the above (e.g. `400`, `401`), or the
  turn was interrupted (`AbortError`);
- the retry budget (`maxRetries`) is exhausted.

Each retry waits an exponential backoff — `200ms × 2^(n-1)` with ±10% jitter —
honoring a server `Retry-After` header when present. A `Warning` event
(`Reconnecting... n/m`) is emitted before each attempt so the UI can surface it.

### Configuration

```ts
const thread = new CodexThread({
  apiKey: "…",
  model: "gpt-5.4",
  // Max retries for transient request/stream failures. Default: 5.
  // Pass 0 to disable retries entirely.
  maxRetries: 5,
});
```

| Option       | Default | Meaning                                                    |
| ------------ | ------- | ---------------------------------------------------------- |
| `maxRetries` | `5`     | Max retry attempts after the initial request. `0` disables. |

The same budget covers both the initial request and a stream that drops before
any output; `Retry-After` overrides the computed backoff for that attempt.
