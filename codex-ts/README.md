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

Transient Responses failures are retried automatically — mirrors codex-rs's
`CodexErr::retry_delay` (`protocol/src/error.rs`) and its stream retry loop
(`responses_retry.rs`).

A failure is **retried** when it happens **before any visible output has
streamed** and is transient:

- a network error (fetch rejects: connection reset, DNS, CORS-masked failure…);
- an HTTP `408`, `409`, `429`, or any `5xx` (e.g. a `502` during a deploy
  window) whose body names no terminal error code (below);
- the SSE stream dropping before the first text delta;
- a `response.failed` event whose error code is transient — `rate_limit_exceeded`
  or `slow_down` (both rate limits) — or unrecognised, matching codex-rs, which
  defaults `response.failed` to retryable;
- `server_is_overloaded` (an SSE `response.failed`, or an HTTP `503` body) —
  **only when the server sent retry advice** (`Retry-After`);
- a `response.incomplete` stopped by a **content filter**: the retry carries
  recovery guidance (`<content_filter_guidance>…`) so the model does not just
  reproduce the blocked output.

A failure is **not retried** when:

- visible output has already streamed (a re-stream would duplicate text);
- the turn was interrupted (`AbortError`);
- it is an HTTP `4xx` other than the above (e.g. `400`, `401`, `403`);
- its error code is terminal — out of credits (`insufficient_quota`,
  `credit_balance_exhausted`, `organization_spend_limit_exceeded`,
  `project_spend_limit_exceeded`, a `429` `usage_limit_reached` /
  `usage_not_included`), a policy block (`cyber_policy`, `bio_policy`,
  `misalignment_policy_violation`, `invalid_prompt`) or `flex_unavailable` —
  or `context_length_exceeded`, which instead triggers compaction / the context
  self-heal;
- the response came back `response.incomplete` for any reason other than a
  content filter (e.g. `max_output_tokens`): terminal since codex-rs #53451.
  What it consumed is still reported in a `TokenCount` event, without replacing
  the context baseline;
- the retry budget (`maxRetries`) is exhausted.

A `response.incomplete` the server **interrupted** (`reason: "interrupted"`) is
not a failure: like a `response.completed` with `end_turn: false`, the turn keeps
what streamed and samples again.

Each retry waits the server's advice when it gave one — a `Retry-After` header
(on the HTTP response, or inside a failed event's `response.error.headers`), or a
provider `…please try again in 1.5s` hint on a rate limit — counted from when the
response arrived; otherwise an exponential backoff, `200ms × 2^(n-1)` with ±10%
jitter. A `Warning` event (`Reconnecting... n/m`) is emitted before each attempt
so the UI can surface it.

When the retries are exhausted (or the failure was terminal), the turn emits an
`Error` event whose `codex_error_info` classifies the cause, followed by a final
`TurnComplete` carrying the same error — so a loop awaiting `TurnComplete` always
terminates. An **interrupted** turn instead ends with `TurnAborted`
(`reason: "interrupted"`), mirroring codex-rs, which never sends `TurnComplete`
for an aborted turn.

## Interrupts

`submit({ type: "Interrupt" })` ends the running turn **at once**, mirroring
codex-rs, which races every tool call against the turn's cancellation token: the
turn does not wait for a tool that is still running — a confirmation nobody
answers, a long download, a hung request — nor for an unanswered
`request_user_input`. `TurnAborted` follows right away; the tool's eventual
result is dropped, and the next turn sees the call as `aborted`.

A JavaScript promise cannot be cancelled, so the tool itself keeps running until
it notices. Every custom tool gets the turn's interrupt signal for that:

```ts
const tool: CustomTool = {
  name: "generate",
  spec: () => spec,
  execute: async (args, ctx) => {
    // Stop work the user no longer wants: close a pending confirmation, cancel
    // a request, skip a step that would spend money.
    const answer = await confirmWithUser(args, { signal: ctx.signal });
    if (ctx.signal.aborted) return "aborted";
    return answer;
  },
};
```

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
