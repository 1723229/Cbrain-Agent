# Claude Code Agent Memory Plugin

This plugin adds Hiper Agent Memory to Claude Code without changing Claude
Code's model endpoint. Model traffic still goes directly to Anthropic; only
memory and knowledge traffic goes to the remote Memory Agent Gateway.

The plugin provides:

- SessionStart and UserPromptSubmit recall hooks;
- asynchronous PostToolUse, Stop, and SessionEnd capture through a local relay;
- one MCP server exposing workspace binding, Memory, Skill, Wiki/RAG, and
  CodeGraph tools;
- central per-workspace Team + Agent binding shared with other supported clients;
- fail-open behavior when memory is unconfigured or temporarily unavailable.

## Prerequisites

- Claude Code 2.1.215 or newer;
- Node.js 22 or newer;
- a Gateway URL and bearer token;
- a local checkout of this repository.

Windows and WSL are separate Claude Code environments. Install and configure
the plugin in each environment where Claude Code runs.

## Install on Windows

Run in PowerShell from the repository root:

```powershell
claude plugin marketplace add (Get-Location).Path
claude plugin install claude-code-agent-memory@hiper-memory-local --scope user
node plugins/claude-code-agent-memory/scripts/agent-memory-setup.mjs
```

The setup command stores the Gateway connection under
`~/.hiper-agent-memory/config.json` without printing the token. For unattended
setup, use deployment-specific values:

```powershell
node plugins/claude-code-agent-memory/scripts/agent-memory-setup.mjs `
  --gateway-url http://gateway.example:8430 `
  --token '<GATEWAY_TOKEN>'
```

Start a new Claude Code session after installation. If an existing session is
open, run `/reload-plugins` or restart it.

## Install on WSL or Linux

Run inside the Linux environment from the Linux-visible repository path:

```sh
cd /path/to/TencentDB-Agent-Memory
claude plugin marketplace add "$PWD"
claude plugin install claude-code-agent-memory@hiper-memory-local --scope user
node plugins/claude-code-agent-memory/scripts/agent-memory-setup.mjs
```

For a Windows checkout mounted in WSL, the repository is usually under `/mnt`.
Windows configuration is not automatically inherited by WSL.

## Install on macOS

Run from the repository root:

```sh
claude plugin marketplace add "$PWD"
claude plugin install claude-code-agent-memory@hiper-memory-local --scope user
node plugins/claude-code-agent-memory/scripts/agent-memory-setup.mjs
```

## Verify

Validate the package and check the current workspace:

```sh
claude plugin validate ./plugins/claude-code-agent-memory --strict
node plugins/claude-code-agent-memory/scripts/agent-memory-doctor.mjs
```

Inspect the installed component inventory with:

```sh
claude plugin details claude-code-agent-memory@hiper-memory-local
```

## Workspace binding

On the first prompt in an unbound workspace, Claude Code presents the available
Teams and Agents and asks for explicit confirmation. It then calls
`workspace_bind` and continues the original request. A workspace is never bound
silently, even when only one Team/Agent pair is available. Task is not part of
the binding model.

Use natural language to manage the binding:

- `查看当前工作区的记忆绑定` uses `workspace_status`;
- `重新绑定当前工作区` uses `workspace_rebind`, followed by `workspace_bind`;
- `解绑当前工作区` uses `workspace_unbind`.

Git remote is only a portable workspace fingerprint. It does not select the
Team. Equivalent Windows and WSL checkouts with the same normalized remote can
reuse the central binding. `HIPER_WORKSPACE_KEY` overrides the fingerprint for
unusual layouts.

## Recall and capture behavior

Session and prompt recall are synchronous because they provide context to the
current turn. Prompt recall has a one-second client budget and a short fail-open
circuit. Raw L0 conversation history is never injected automatically; use
`conversation_search` when concrete prior dialogue is needed.

PostToolUse, Stop, and SessionEnd send one loopback UDP datagram to a detached
relay. The relay batches events in memory and contacts the Gateway outside the
interactive hook path. Writes are best effort and may be dropped. No local
SQLite database or durable outbox is created.

The relay binds only to `127.0.0.1`, authenticates datagrams with a random
per-process nonce, and never stores the Gateway token in its descriptor. It
exits after five idle minutes.

The bundled `agent-memory` skill teaches Claude when to use explicit Memory,
Wiki/RAG, and CodeGraph tools. It can also be invoked manually as
`/claude-code-agent-memory:agent-memory`.

## Update

After pulling repository changes:

```sh
claude plugin marketplace update hiper-memory-local
claude plugin update claude-code-agent-memory@hiper-memory-local
```

Then run `/reload-plugins` or start a new Claude Code session. Repeat the update
inside WSL if Claude Code is used there.
