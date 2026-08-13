# Memory Agent Gateway

Model-independent Gateway for Codex. Codex continues to call OpenAI directly;
this service only handles memory lifecycle hooks and read-only MCP tools.

Required configuration:

```text
HIPER_AGENT_GATEWAY_TOKEN=<client bearer token>
HIPER_CORE_URL=http://memory-core:8420
HIPER_KNOWLEDGE_URL=http://memory-knowledge:8424
HIPER_SERVICE_ID=<service id>
HIPER_SERVICE_TOKEN=<service token, when enabled>
HIPER_USER_ID=<bearer principal user id>
HIPER_USER_KEY=<bearer principal user key, recommended>
```

`HIPER_TEAM_ID` and `HIPER_AGENT_ID` are optional defaults for backward
compatibility. New Codex clients resolve a portable workspace key through
`/v1/workspaces/resolve`, then complete an unbound selection through
`/v1/workspaces/bind` or the bootstrap `workspace_bind` MCP tool. The Gateway
stores this mapping centrally and verifies that the Agent is active, belongs to
the Team, and is owned by the bearer principal. Task is not part of workspace
binding.

Workspace bindings can be inspected, reselected, or removed through
`workspace_status`, `workspace_rebind`, and `workspace_unbind`. Reselection
returns a fresh short-lived binding request and still completes through the same
validated `workspace_bind` path.

For multiple users, replace the single bearer/user variables with
`HIPER_GATEWAY_PRINCIPALS_JSON`, an array of objects containing `id`, `token`,
`userId`, optional `userKey`, and optional default Team/Agent IDs.

The Gateway stores opaque session contexts and durable capture/extraction queues
in `HIPER_AGENT_GATEWAY_DB` (default `./data/gateway.sqlite`). It sends each
completed root prompt/final answer pair independently to Core L0 and Skill
conversation accumulation until both acknowledge it. Codex `PostToolUse` events
are sanitized and joined to their turn. `SessionEnd` then queues the complete
session transcript for Core's direct `/v3/skill/extract` path, so short Codex
sessions do not depend on the native 10-tool-call/40KB accumulation thresholds.

`memory_status` reports the current session's latest Skill extraction state and
task ID. `submitted` means Core accepted an asynchronous extraction task; the
extractor may still decide that the session contains no reusable Skill.
Trivial sessions are marked `skipped` unless they contain at least one tool call
and enough work content; the native per-session accumulation path remains active.

Recall-specific controls are independent from the longer Core worker timeout:

```text
HIPER_RECALL_TIMEOUT_MS=800
HIPER_RECALL_MIN_SCORE=0.75
HIPER_SESSION_CONTEXT_TIMEOUT_MS=1500
HIPER_KNOWLEDGE_CACHE_TTL_MS=30000
HIPER_SKILL_SETTLE_MS=5000
HIPER_CAPTURE_CONCURRENCY=4
HIPER_CAPTURE_MAX_ATTEMPTS=8
```

Each prompt fetches L1, L2, and L3 in parallel. A slow layer degrades independently
at the recall timeout. L2/L3 are injected only when L1 establishes that memory is
relevant to the current query, preventing stable context from polluting small talk.
SessionEnd extraction remains pending for the settle window so batched Stop and
PostToolUse events can arrive before the transcript is read. New clients submit up
to 32 ordered write events through `POST /v1/hooks/batch`; invalid events are isolated
within the batch and existing single-event endpoints remain backward compatible.
Batch requests are limited to 512 KiB and reuse the same durable idempotency rules.

The worker processes independent events and Core/Skill sinks concurrently.
Failures use bounded exponential retry; exhausted work is retained as a dead
letter for seven days. `/health/ready` reports pending counts, dead-letter counts,
and the oldest pending age. Health endpoints are `/health/live` and
`/health/ready`. Build with `pnpm build`.
