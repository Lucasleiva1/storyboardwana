[CmdletBinding()]
param(
  [ValidatePattern("^[a-p]{32}$")]
  [string]$ExtensionId = "kdmgiohkeeehnpaccfmjgiccfbaodlhg",
  [string]$HostPath,
  [switch]$Release
)

$ErrorActionPreference = "Stop"
$hostName = "com.framesync.capture"
$repositoryRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($HostPath)) {
  $profile = if ($Release) { "release" } else { "debug" }
  $HostPath = Join-Path $repositoryRoot "target\$profile\framesync-native-host.exe"
}

if (-not (Test-Path -LiteralPath $HostPath -PathType Leaf)) {
  throw "No se encontró el host en '$HostPath'. Compilalo primero con: cargo build --manifest-path crates/native-host/Cargo.toml"
}

$resolvedHost = (Resolve-Path -LiteralPath $HostPath).Path
$manifestDirectory = Join-Path $env:LOCALAPPDATA "FrameSync\native-host"
$manifestPath = Join-Path $manifestDirectory "$hostName.json"
New-Item -ItemType Directory -Path $manifestDirectory -Force | Out-Null

$manifest = [ordered]@{
  name = $hostName
  description = "FrameSync Capture Native Messaging Host"
  path = $resolvedHost
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

Write-Host "Host registrado para el usuario actual."
Write-Host "Manifest: $manifestPath"
Write-Host "Ejecutable: $resolvedHost"
Write-Host "Extensión permitida: $ExtensionId"

