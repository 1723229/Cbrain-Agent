param([string]$Gateway)

$ErrorActionPreference = "Stop"
if (-not $Gateway) { $Gateway = Read-Host "Cbrain Gateway URL" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required."
}
$major = [int]((node --version).TrimStart("v").Split(".")[0])
if ($major -lt 22) { throw "Node.js 22 or newer is required." }

& node (Join-Path $PSScriptRoot "offline-cli.mjs") --gateway $Gateway
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
