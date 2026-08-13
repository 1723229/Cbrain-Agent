# Cbrain Agent Memory Installer

Install and connect the Cbrain plugin without cloning the source repository:

```bash
npx --yes cbrain-agent install codex --gateway https://cbrain.example
npx --yes cbrain-agent install claude-code --gateway https://cbrain.example
```

The installer asks for the API Key created on the Cbrain API Key page without
echoing it, verifies the account, installs the remote plugin, and stores the
credential in the current user's private configuration file.
