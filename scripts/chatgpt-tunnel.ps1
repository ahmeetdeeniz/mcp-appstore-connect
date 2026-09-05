param(
  [string]$Alias = "app-store-connect",
  [switch]$Writes
)

$ErrorActionPreference = "Stop"

function Require-Env([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing environment variable: $Name"
  }
  return $value
}

Require-Env "CONTROL_PLANE_API_KEY" | Out-Null
$tunnelId = Require-Env "CONTROL_PLANE_TUNNEL_ID"

if ($Writes) {
  $env:APP_STORE_CONNECT_ALLOW_WRITES = "1"
  Write-Host "App Store Connect write tools: ENABLED"
} else {
  Remove-Item Env:APP_STORE_CONNECT_ALLOW_WRITES -ErrorAction SilentlyContinue
  Write-Host "App Store Connect write tools: disabled (read-only registration)"
}

pnpm build

$entry = (Resolve-Path (Join-Path $PSScriptRoot "..\dist\cli.js")).Path
$mcpCommand = "node `"$entry`""

& tunnel-client runtimes connect `
  --alias $Alias `
  --tunnel-id $tunnelId `
  --runtime-api-key env:CONTROL_PLANE_API_KEY `
  --mcp-command $mcpCommand

if ($LASTEXITCODE -ne 0) { throw "tunnel-client runtimes connect failed with exit code $LASTEXITCODE" }

& tunnel-client runtimes status $Alias --json
if ($LASTEXITCODE -ne 0) { throw "tunnel-client runtimes status failed with exit code $LASTEXITCODE" }
