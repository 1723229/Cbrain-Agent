# Codex Agent Memory Plugin

This plugin adds TencentDB Agent Memory to Codex without changing Codex's model
endpoint. Model traffic still goes directly to OpenAI; only memory and knowledge
traffic goes to the remote Gateway.

The plugin provides:

- SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd hooks for L0-L3 recall, best-effort work traces, and direct Skill extraction;
- one bootstrap binding MCP tool plus read-only tools for Memory, Skill, Wiki originals/pages/graph, and CodeGraph;
- central per-workspace Team + Agent bindings, with multiple directories allowed to use the same pair;
- fail-open, best-effort write hooks and a dormant MCP mode when unconfigured.

## Prerequisites

- Codex CLI with plugin support;
- Node.js 22 or newer;
- a Gateway URL and bearer token;
- a local checkout of this repository.

Windows and WSL are separate Codex environments with separate home directories.
If Codex is used in both, install and configure the plugin once in Windows and
once inside WSL.

## Install on Windows

Run these commands in PowerShell from the repository root:

```powershell
codex plugin marketplace add (Get-Location).Path
codex plugin add codex-agent-memory@hiper-memory-local
node plugins/codex-agent-memory/scripts/agent-memory-setup.mjs
```

The marketplace command is needed only the first time this repository is added
to that Codex environment. The setup command prompts only for the Gateway
connection and stores the token without printing it. Team and Agent are selected
inside the first Codex conversation opened for an unbound workspace.

For non-interactive setup, use placeholders for the deployment-specific values:

```powershell
node plugins/codex-agent-memory/scripts/agent-memory-setup.mjs `
  --gateway-url http://gateway.example:8430 `
  --token '<GATEWAY_TOKEN>'
```

Start an interactive `codex` session after installation. On the first run,
review and allow the plugin's SessionStart, UserPromptSubmit, PostToolUse, Stop,
and SessionEnd hooks when
Codex prompts. Then start a new conversation so the installed hooks and MCP tools
are loaded from a clean session.

## Install in WSL or Linux

Run the commands inside the Linux environment, from the Linux-visible repository
path. For a Windows checkout mounted in WSL, that is usually a path below `/mnt`:

```sh
cd /mnt/d/github/TencentDB-Agent-Memory
codex plugin marketplace add "$PWD"
codex plugin add codex-agent-memory@hiper-memory-local
node plugins/codex-agent-memory/scripts/agent-memory-setup.mjs
```

Run interactive `codex` once and approve all five hooks when prompted. A plugin
installed or trusted by Windows Codex is not automatically installed or trusted
by WSL Codex.

For audited CI or a one-off non-interactive test only, Codex supports
`--dangerously-bypass-hook-trust`. Do not use that flag as the normal daily setup;
interactive review and approval is the intended trust path.

## Install on macOS

Run these commands from the repository root:

```sh
codex plugin marketplace add "$PWD"
codex plugin add codex-agent-memory@hiper-memory-local
node plugins/codex-agent-memory/scripts/agent-memory-setup.mjs
```

As on Linux, start interactive `codex`, review and approve the hooks, and then
open a new conversation.

## Verify the binding

From the repository root, run:

```sh
node plugins/codex-agent-memory/scripts/agent-memory-doctor.mjs
```

The doctor checks the current workspace without printing the token. Configuration and
runtime context state live under `~/.hiper-agent-memory/`.
There is no local SQLite database. Keep the configuration directory private; on
Unix-like systems the setup script applies user-only permissions.

Session and prompt recall are synchronous because they provide context to the current
turn. Prompt recall has a one-second client budget and opens a 30-second fail-open
circuit after a failure. PostToolUse, Stop, and SessionEnd write hooks send one local
loopback datagram to a shared event relay, which batches events in memory before
contacting the Gateway. The MCP bridge ensures the relay is running, but the relay has
an independent idle lifecycle so it remains available for Stop/SessionEnd after the MCP
connection closes. Writes do not wait for a remote response and intentionally allow event loss.
The local handoff still has a small process and loopback-I/O cost, but a slow or
unavailable Gateway is removed from the write-hook critical path.

The relay is bound to `127.0.0.1`, authenticated with a per-process random nonce, and
never writes the Gateway token into its descriptor. It keeps at most 256 events or
2 MiB in memory, sends batches of at most 32, and prioritizes Stop/SessionEnd when the
queue is full. No local SQLite or durable client outbox is created. One relay is shared
per Gateway configuration and exits after five idle minutes. At relay shutdown it allows
a 50ms loopback grace period and drains its final batch under the existing two-second
sender timeout; this happens outside the active conversation path.

Automatic per-prompt recall fetches structured L1, L2 scene navigation, and L3
persona in parallel under the Gateway's short recall timeout. Raw L0 conversation
history is available only through the explicit `conversation_search` MCP tool.
For Codex, current L1 relevance gates injection of L2/L3 so small talk receives no
stable memory payload. Raw L0 is never injected automatically.

On the first user prompt in an unbound workspace, Codex asks for Team and Agent,
calls the bootstrap `workspace_bind` MCP tool, and then continues the original
request. Task is not part of this interaction. A new workspace is never bound
silently: even when exactly one valid Team/Agent pair exists, Codex asks for
explicit confirmation. A Team without an active Agent is shown as unavailable.
The binding is stored in the Gateway, not in a local SQLite database, and is
reused by later sessions.

## View, change, or remove a binding

In a bound Codex conversation, use natural language:

- `查看当前工作区的记忆绑定` calls `workspace_status`.
- `重新绑定当前工作区` calls `workspace_rebind`, presents the current Team/Agent choices, and completes the selected pair with `workspace_bind`.
- `解绑当前工作区` calls `workspace_unbind`. The next prompt asks for a new binding again.

Rebinding and unbinding affect only the current principal and portable workspace
key. They do not delete Team, Agent, Memory, Wiki, CodeGraph, or Git data. An
Agent belongs to one Team; a Team with no active Agent cannot be selected.

Git remote is used only as a portable workspace fingerprint; it does not decide
the Team. Equivalent Windows and WSL checkouts share a central binding when they
have the same normalized remote. Repositories without a Git remote use a
normalized path fallback. `HIPER_WORKSPACE_KEY` can explicitly override the
fingerprint for unusual layouts. Several directories can intentionally use the
same Team/Agent by selecting the same pair for each workspace.

The selection cannot appear in a completely empty Codex thread because hooks do
not have a user-facing prompt surface before the first model turn. It appears
after the first user message; that original message is retained and resumed after
binding succeeds.

## Update an installation

After updating the repository checkout, reinstall the marketplace snapshot from
the repository root:

```sh
codex plugin add codex-agent-memory@hiper-memory-local
```

If `codex plugin add` reports that the plugin is not found, refresh the local
marketplace registration first, then retry the install:

```sh
codex plugin marketplace add "$PWD"
codex plugin add codex-agent-memory@hiper-memory-local
```

Repeat the reinstall in every environment where Codex is used, including WSL.
Start a new Codex conversation after reinstalling.

The setup command also removes the obsolete `tdai-memory-local` registration through
the official Codex plugin commands. Close existing Codex processes after migration;
already-running sessions retain the plugin snapshot they started with.
