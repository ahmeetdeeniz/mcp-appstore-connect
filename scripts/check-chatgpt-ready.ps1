$ErrorActionPreference = "Stop"

Write-Host "== App Store Connect MCP / ChatGPT readiness =="

$nodeVersion = node --version
Write-Host "Node: $nodeVersion"

pnpm typecheck
pnpm test
pnpm build

$entry = Resolve-Path (Join-Path $PSScriptRoot "..\dist\cli.js")
Write-Host "Built MCP entry: $entry"

if (Get-Command tunnel-client -ErrorAction SilentlyContinue) {
  Write-Host "tunnel-client: available"
  tunnel-client help quickstart | Out-Null
} else {
  Write-Warning "tunnel-client is not installed yet. Install it when preparing the Business tunnel."
}

Write-Host "Repo-side readiness checks passed. Business-only tunnel/workspace credentials are intentionally not checked here."
