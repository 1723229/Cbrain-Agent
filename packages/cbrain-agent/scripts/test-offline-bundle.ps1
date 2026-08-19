param()

$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -Raw -LiteralPath (Join-Path $packageRoot "package.json") | ConvertFrom-Json
$archives = @(
  @{ Client = "codex"; Path = "dist/cbrain-codex-plugin-offline-$($package.version).zip" },
  @{ Client = "claude-code"; Path = "dist/cbrain-claude-code-plugin-offline-$($package.version).zip" }
)
$sourceConfig = Join-Path $env:USERPROFILE ".cbrain-agent/config.json"
if (-not (Test-Path -LiteralPath $sourceConfig)) {
  throw "Existing Cbrain config is unavailable for safe real verification."
}
$connection = Get-Content -Raw -LiteralPath $sourceConfig | ConvertFrom-Json
if ((-not $connection.apiKey) -or -not $connection.gatewayUrl) {
  throw "Existing Cbrain config does not contain a credential and gatewayUrl."
}
$verificationKey = $connection.apiKey

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cbrain-offline-e2e-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  $testHome = Join-Path $testRoot "home"
  $codexHome = Join-Path $testHome ".codex"
  New-Item -ItemType Directory -Path $codexHome -Force | Out-Null

  $previous = @{
    USERPROFILE = $env:USERPROFILE
    HOME = $env:HOME
    CODEX_HOME = $env:CODEX_HOME
    CBRAIN_API_KEY = $env:CBRAIN_API_KEY
  }
  $env:USERPROFILE = $testHome
  $env:HOME = $testHome
  $env:CODEX_HOME = $codexHome
  $env:CBRAIN_API_KEY = $verificationKey
  try {
    foreach ($archive in $archives) {
      $extractRoot = Join-Path $testRoot ("extract-" + $archive.Client)
      $archivePath = [System.IO.Path]::GetFullPath((Join-Path $packageRoot $archive.Path))
      Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
      $bundle = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bundle.FullName "install.ps1") -Gateway $connection.gatewayUrl
      if ($LASTEXITCODE -ne 0) { throw "$($archive.Client) offline install failed." }
    }
    Get-ChildItem -LiteralPath $testRoot -Directory -Filter "extract-*" | Remove-Item -Recurse -Force

    $saved = Get-Content -Raw -LiteralPath (Join-Path $testHome ".cbrain-agent/config.json") | ConvertFrom-Json
    $codexMarkets = codex plugin marketplace list --json | ConvertFrom-Json
    $codexPlugins = codex plugin list --json | ConvertFrom-Json
    $claudeMarkets = claude plugin marketplace list --json | ConvertFrom-Json
    $claudePlugins = claude plugin list --json | ConvertFrom-Json
    $checks = [ordered]@{
      codex_marketplace_present = [bool]($codexMarkets.marketplaces | Where-Object name -eq "cbrain")
      codex_plugin_installed = [bool]($codexPlugins.installed | Where-Object pluginId -eq "cbrain-agent@cbrain")
      claude_marketplace_present = [bool]($claudeMarkets | Where-Object name -eq "cbrain")
      claude_plugin_installed = [bool]($claudePlugins | Where-Object id -eq "cbrain-agent@cbrain")
      config_gateway_matches = $saved.gatewayUrl -eq $connection.gatewayUrl
      config_has_api_key = [bool]$saved.apiKey
      stable_codex_bundle = Test-Path -LiteralPath (Join-Path $testHome ".cbrain-agent/offline/codex/bundle.json")
      stable_claude_bundle = Test-Path -LiteralPath (Join-Path $testHome ".cbrain-agent/offline/claude-code/bundle.json")
    }
    if ($checks.Values -contains $false) { throw "Offline verification failed: $($checks | ConvertTo-Json -Compress)" }
    $checks | ConvertTo-Json -Compress
  } finally {
    $env:USERPROFILE = $previous.USERPROFILE
    $env:HOME = $previous.HOME
    $env:CODEX_HOME = $previous.CODEX_HOME
    $env:CBRAIN_API_KEY = $previous.CBRAIN_API_KEY
  }
} finally {
  $resolved = [System.IO.Path]::GetFullPath($testRoot)
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolved.StartsWith($tempRoot) -and (Split-Path -Leaf $resolved).StartsWith("cbrain-offline-e2e-")) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  } else {
    throw "Refusing to remove unexpected test path."
  }
}
