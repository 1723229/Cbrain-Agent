#!/usr/bin/env sh
set -eu

if [ -n "${CBRAIN_CONFIG_FILE:-}" ]; then
  CBRAIN_API_KEY=$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.apiKey||c.token||"")' "$CBRAIN_CONFIG_FILE")
  CBRAIN_GATEWAY_URL=$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.gatewayUrl||"")' "$CBRAIN_CONFIG_FILE")
  export CBRAIN_API_KEY CBRAIN_GATEWAY_URL
fi
: "${CBRAIN_API_KEY:?CBRAIN_API_KEY or CBRAIN_CONFIG_FILE is required}"
: "${CBRAIN_GATEWAY_URL:?CBRAIN_GATEWAY_URL or CBRAIN_CONFIG_FILE is required}"

package_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/cbrain-offline-e2e.XXXXXX")
cleanup() { rm -rf -- "$test_root"; }
trap cleanup EXIT INT TERM

export HOME="$test_root/home"
export CODEX_HOME="$HOME/.codex"
mkdir -p "$CODEX_HOME"

for bundle in codex claude-code; do
  case "$bundle" in
    codex) archive="$package_root/dist/cbrain-codex-plugin-offline-0.1.0.zip" ;;
    claude-code) archive="$package_root/dist/cbrain-claude-code-plugin-offline-0.1.0.zip" ;;
  esac
  extract="$test_root/extract-$bundle"
  mkdir -p "$extract"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$archive" -d "$extract"
  else
    python3 -m zipfile -e "$archive" "$extract"
  fi
  bundle_root=$(find "$extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  sh "$bundle_root/install.sh" "$CBRAIN_GATEWAY_URL"
done

node -e '
const {readFileSync}=require("fs");
const config=JSON.parse(readFileSync(process.env.HOME+"/.hiper-agent-memory/config.json","utf8"));
if(config.gatewayUrl!==process.env.CBRAIN_GATEWAY_URL||!config.apiKey)process.exit(1);
console.log(JSON.stringify({config_gateway_matches:true,config_has_api_key:true}));
'
codex plugin list --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const x=JSON.parse(s);if(!x.installed?.some(p=>p.pluginId==="codex-agent-memory@cbrain-offline"))process.exit(1);console.log(JSON.stringify({codex_plugin_installed:true}))})'
claude plugin list --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const x=JSON.parse(s);if(!x.some(p=>p.id==="claude-code-agent-memory@cbrain-offline"))process.exit(1);console.log(JSON.stringify({claude_plugin_installed:true}))})'
