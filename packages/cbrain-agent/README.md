# Cbrain Agent Memory Installer

Install and connect the Cbrain plugin without cloning the source repository:

```bash
npx --yes cbrain-agent install codex --gateway https://cbrain.example
npx --yes cbrain-agent install claude-code --gateway https://cbrain.example
```

The installer package contains the Codex and Claude Code plugin sources and
local Marketplace metadata. It does not clone GitHub repositories or require
GitHub SSH access. It asks for the API Key created on the Cbrain API Key page
without echoing it, verifies the account, installs the local plugin, and stores
the credential in the current user's private configuration file.

Installing again performs a non-destructive update: Codex uses a new cachebuster
version and Claude Code uses its update command. Existing configuration, bindings,
and older cache entries are not deleted.

Remove only the client plugin while preserving Cbrain configuration and server data:

```bash
npx --yes cbrain-agent uninstall codex
npx --yes cbrain-agent uninstall claude-code
```
