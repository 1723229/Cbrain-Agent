#!/usr/bin/env sh
set -eu

gateway="${1:-}"
if [ -z "$gateway" ]; then
  printf "Cbrain Gateway URL: "
  IFS= read -r gateway
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi
major="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "$major" -lt 22 ]; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/offline-cli.mjs" --gateway "$gateway"
