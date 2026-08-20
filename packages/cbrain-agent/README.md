# Cbrain Agent Memory Installer

Sign in to Cbrain, open the **API Key** page, and copy the install command generated
for that deployment. The command uses the installer archive served by the Cbrain
instance rather than an unpublished npm package. For example:

```bash
npx --yes --package "https://cbrain.example/downloads/cbrain-agent.tgz" cbrain-agent install codex --gateway https://cbrain-gateway.example
npx --yes --package "https://cbrain.example/downloads/cbrain-agent.tgz" cbrain-agent install claude-code --gateway https://cbrain-gateway.example
```

The installer package contains the Codex and Claude Code plugin sources and
local Marketplace metadata. It does not access npm, clone GitHub repositories,
or require GitHub SSH access. It asks for the API Key created on the Cbrain API Key page
without echoing it, verifies the account, installs the local plugin, and stores
the credential in the current user's private configuration file.

Installing again performs a non-destructive update: Codex uses a new cachebuster
version and Claude Code uses its update command. Existing configuration, bindings,
and older cache entries are not deleted.

Remove only the client plugin while preserving Cbrain configuration and server data:

```bash
npx --yes --package "https://cbrain.example/downloads/cbrain-agent.tgz" cbrain-agent uninstall codex
npx --yes --package "https://cbrain.example/downloads/cbrain-agent.tgz" cbrain-agent uninstall claude-code
```
