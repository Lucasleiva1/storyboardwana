[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
  param(
    [string]$Name,
    [bool]$Ok,
    [string]$Detail
  )

  $checks.Add([PSCustomObject]@{
    Check = $Name
    Status = if ($Ok) { "OK" } else { "FALTA" }
    Detail = $Detail
  })
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
Add-Check "Node.js" ($null -ne $node) $(if ($node) { (& $node.Source --version) } else { "Instalar Node LTS" })

$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
Add-Check "pnpm.cmd" ($null -ne $pnpm) $(if ($pnpm) { (& $pnpm.Source --version) } else { "Habilitar Corepack o instalar pnpm" })

$rustc = Get-Command rustc.exe -ErrorAction SilentlyContinue
Add-Check "Rust MSVC" ($null -ne $rustc) $(if ($rustc) { (& $rustc.Source -vV | Select-String "host:").ToString() } else { "Instalar rustup con toolchain MSVC" })

$vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
$buildToolsPath = $null
if (Test-Path -LiteralPath $vswhere) {
  $buildToolsPath = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
Add-Check "C++ Build Tools" (-not [string]::IsNullOrWhiteSpace($buildToolsPath)) $(if ($buildToolsPath) { $buildToolsPath } else { "Instalar Desktop development with C++" })

$webViewRoots = @(
  "C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
  "C:\Program Files\Microsoft\EdgeWebView\Application"
)
$webViewVersion = $null
foreach ($root in $webViewRoots) {
  if (Test-Path -LiteralPath $root) {
    $webViewVersion = Get-ChildItem -LiteralPath $root -Directory |
      Where-Object { $_.Name -match "^\d+\." } |
      Sort-Object Name -Descending |
      Select-Object -First 1 -ExpandProperty Name
    if ($webViewVersion) { break }
  }
}
Add-Check "WebView2" ($null -ne $webViewVersion) $(if ($webViewVersion) { $webViewVersion } else { "Instalar WebView2 Evergreen Runtime" })

$edgePaths = @(
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
)
$edge = $edgePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
Add-Check "Microsoft Edge" ($null -ne $edge) $(if ($edge) { $edge } else { "Instalar Edge" })

$checks | Format-Table -AutoSize
if ($checks.Status -contains "FALTA") {
  exit 1
}
