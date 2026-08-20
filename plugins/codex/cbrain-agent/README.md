# Cbrain Plugin for Codex

Codex continues to call OpenAI directly. The plugin sends only memory,
Wiki/RAG, CodeGraph, Skill, and workspace-binding traffic to Cbrain.

## Workspace display name

By default, Cbrain displays the Git root directory name. A project can define a stable display name without renaming its directory by adding `.cbrain.json` at the Git root:

```json
{
  "workspaceLabel": "Cbrain"
}
```

`CBRAIN_AGENT_WORKSPACE_LABEL` can override the project value for a specific environment.

## Install

Requirements: Codex with plugin support and Node.js 22 or newer. Create an API
Key on the Cbrain **API Key** page, then copy the deployment-specific command
shown there. For example:

```powershell
npx --yes --package "https://cbrain.example/downloads/cbrain-agent.tgz" cbrain-agent install codex --gateway https://cbrain-gateway.example
```

The command works on Windows, macOS, Linux, and WSL. It downloads the plugin
bundle from the Cbrain instance, securely prompts for the page API Key, verifies
the account, and writes `~/.cbrain-agent/config.json`. It does not require npm
publication, GitHub access, a source checkout, or an administrator-created
Gateway Token. Windows and WSL have separate home directories, so run the
command once in each environment you use.

Start a fresh Codex session after installation. Review and approve the plugin's
hooks when Codex asks. If the account has exactly one active Team-Agent pair,
an unbound project is bound automatically. If there are multiple pairs, select
a Team and Agent; the original prompt then continues.

## Behavior

- SessionStart and UserPromptSubmit synchronously recall relevant L1-L3 context
  under short fail-open timeouts. Raw L0 dialogue is available only through the
  explicit `conversation_search` tool and is never injected automatically.
- PostToolUse, Stop, and SessionEnd enqueue best-effort events through a local
  loopback relay. They do not wait for the remote Gateway and may be dropped.
- MCP exposes a task-oriented workspace, Memory, Skill, Wiki/RAG, and CodeGraph
  surface. Wiki search spans every Wiki bound to the active Agent by default;
  page and source reads use opaque references returned by the Gateway.
- Bindings are stored centrally by user and portable workspace key. Git remote
  is only the workspace fingerprint; it does not choose a Team.
- Multiple directories may bind to the same Team and Agent. Windows and WSL
  checkouts with the same normalized remote can share the central binding.

Manage a binding in natural language: `查看当前工作区的记忆绑定`、`重新绑定当前工作区`
or `解绑当前工作区`.

## Update and diagnostics

Re-run the install command to refresh the remote plugin. For source-development
diagnostics only, run `node scripts/cbrain-agent-doctor.mjs` from this plugin
directory. The diagnostic output never prints the API Key.

The plugin reads only `{ "gatewayUrl", "apiKey" }`; legacy Gateway Token configuration is not supported.
