# Cbrain Agent Gateway

Model-independent Gateway for Codex. Codex continues to call OpenAI directly;
this service only handles memory lifecycle hooks and read-only MCP tools.

Required service configuration:

```text
CBRAIN_CORE_URL=http://memory-core:8420
CBRAIN_KNOWLEDGE_URL=http://memory-knowledge:8424
CBRAIN_SERVICE_ID=<service id>
CBRAIN_SERVICE_TOKEN=<internal service token, when enabled>
```

Clients authenticate with the regular API Key created on the Cbrain API Key
page. The Gateway verifies it through Core `/v3/meta/auth/verify`; per-user
Gateway Tokens and per-user server configuration do not exist: clients send the
page API Key directly and the Gateway validates it through Core.

Codex and Claude Code clients resolve a portable workspace key through
`/v1/workspaces/resolve`, then complete an unbound selection through
`/v1/workspaces/bind` or the bootstrap `workspace_bind` MCP tool. The Gateway
stores this mapping centrally and verifies that the Agent is active, belongs to
the Team, and is owned by the bearer principal. Task is not part of workspace
binding.

Workspace bindings can be inspected, reselected, or removed through
`workspace_status`, `workspace_rebind`, and `workspace_unbind`. Reselection
returns a fresh short-lived binding request and still completes through the same
validated `workspace_bind` path.

Page API Keys are request-scoped and are never persisted in Gateway SQLite.
`CBRAIN_SERVICE_TOKEN` is an optional internal service-to-service credential;
it is never exposed to plugins or users.

## MCP profiles

`/mcp` is the full coding-agent profile. It exposes 24 task-oriented tools:
four explicit workspace-binding operations plus Memory, Skill, Wiki/RAG, and
CodeGraph retrieval. Every non-workspace call requires the opaque `context_id`
provided when the coding session starts.

`/mcp/wiki` is the standalone Wiki/RAG profile for external Agents that only
need to reference existing plans, operating documents, and lessons learned. It
exposes six read-only tools: `wiki_resources`, `wiki_search`, `wiki_list`,
`wiki_read`, `wiki_source_read`, and `wiki_related`.

The standalone profile requires only the normal page API Key as a Bearer token.
The Gateway resolves every active Agent owned by that user across Teams,
intersects each Agent's fixed Wiki bindings with its readable assets, keeps only
ready Wikis, and deduplicates shared Wikis. Callers never send `team_id`,
`agent_id`, or `context_id`. `wiki_search` searches the whole resolved scope by
default and merges per-Wiki BM25 rankings with reciprocal-rank fusion; one
failed Wiki is reported as a warning while successful results remain usable.

MCP clients should configure the Streamable HTTP URL as
`https://<gateway>/mcp/wiki` and send `Authorization: Bearer <Cbrain API Key>`.
Future additive tools or optional fields require only a Gateway update and MCP
reconnection. Renaming tools or adding required parameters is a breaking
contract change and must use a new profile/version.

The Gateway stores opaque session contexts and durable capture/extraction queues
in `CBRAIN_AGENT_GATEWAY_DB` (default `./data/gateway.sqlite`). It sends each
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
CBRAIN_RECALL_TIMEOUT_MS=800
CBRAIN_RECALL_MIN_SCORE=0.75
CBRAIN_SESSION_CONTEXT_TIMEOUT_MS=1500
CBRAIN_KNOWLEDGE_CACHE_TTL_MS=30000
CBRAIN_SKILL_SETTLE_MS=5000
CBRAIN_CAPTURE_CONCURRENCY=4
CBRAIN_CAPTURE_MAX_ATTEMPTS=8
CBRAIN_CAPTURE_TIMEOUT_MS=30000
```

`CBRAIN_CAPTURE_TIMEOUT_MS` applies only to the asynchronous Core L0 capture
worker. Authentication, directory access, recall, and MCP reads keep their
shorter interactive timeouts. Each capture sends its durable queue event ID as
Core's idempotency key, so an ambiguous timeout can be retried safely.

`CBRAIN_RECALL_MIN_SCORE` is a normalized 0..1 confidence threshold. Core
SQLite hybrid-search RRF scores are normalized to the same scale before this
filter is applied; embedding/native similarity scores keep their original
scale.

Each prompt fetches L1, L2, and L3 in parallel. A slow layer degrades independently
at the recall timeout. L2/L3 are injected only when L1 establishes that memory is
relevant to the current query, preventing stable context from polluting small talk.
SessionEnd extraction remains pending for the settle window so batched Stop and
PostToolUse events can arrive before the transcript is read. New clients submit up
to 32 ordered write events through `POST /v1/hooks/batch`; invalid events are isolated
within the batch and existing single-event endpoints remain backward compatible.
Batch requests are limited to 512 KiB and reuse the same durable idempotency rules.
If a SessionEnd arrives without any completed conversation, the extraction is recorded
as `skipped` rather than retried or reported as a dead letter.

The worker processes independent events and Core/Skill sinks concurrently.
Failures use bounded exponential retry; exhausted work is retained as a dead
letter for seven days. `/health/ready` reports pending counts, dead-letter counts,
and the oldest pending age. Health endpoints are `/health/live` and
`/health/ready`. Build with `pnpm build`.

For a read-only validation against an existing Core/Knowledge deployment, first
build the Gateway and configure the current user's normal Cbrain API Key, then
run `pnpm test:e2e:real`. The script starts a local Gateway with a fresh
temporary SQLite database, exercises both MCP profiles, and removes only that
temporary directory. Override the upstreams with `CBRAIN_E2E_CORE_URL` and
`CBRAIN_E2E_KNOWLEDGE_URL` when needed.
