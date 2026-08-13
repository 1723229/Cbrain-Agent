$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -Raw (Join-Path $packageRoot "package.json") | ConvertFrom-Json

Push-Location $packageRoot
try {
  & node "scripts/build-offline-bundle.mjs"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $bundleNames = @("cbrain-codex-plugin-offline-$($package.version)", "cbrain-claude-code-plugin-offline-$($package.version)")
  foreach ($bundleName in $bundleNames) {
    $bundlePath = Join-Path $packageRoot "dist/$bundleName"
    $archivePath = Join-Path $packageRoot "dist/$bundleName.zip"
    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
    Compress-Archive -LiteralPath $bundlePath -DestinationPath $archivePath -CompressionLevel Optimal
    Write-Output $archivePath
  }
} finally {
  Pop-Location
}
