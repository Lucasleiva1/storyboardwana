[CmdletBinding()]
param(
  [string]$ReleaseNotes = "Primera versión pública de FrameSync para Windows.",
  [string]$OwnerRepo = "Lucasleiva1/storyboardwana",
  [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$pnpm = Join-Path $env:APPDATA "npm\pnpm.cmd"
$keyDirectory = Join-Path $env:APPDATA "FrameSync\updater"
$keyPath = Join-Path $keyDirectory "tauri-updater.key"
$passwordPath = Join-Path $keyDirectory "tauri-updater-password.txt"

function Assert-LastExitCode([string]$Action) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Action falló con código $LASTEXITCODE."
  }
}

function Assert-SafeReleasePath([string]$Path) {
  $resolvedRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $repositoryRoot "target\release\bundle")
  )
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Ruta de release insegura: $resolvedPath"
  }
}

Push-Location $repositoryRoot
try {
  $rootPackage = Get-Content -Raw -LiteralPath "package.json" | ConvertFrom-Json
  $desktopPackage = Get-Content -Raw -LiteralPath "apps\desktop\package.json" | ConvertFrom-Json
  $extensionPackage = Get-Content -Raw -LiteralPath "apps\extension\package.json" | ConvertFrom-Json
  $tauriConfig = Get-Content -Raw -LiteralPath "apps\desktop\src-tauri\tauri.conf.json" | ConvertFrom-Json
  $version = [string]$rootPackage.version
  $cargoMetadata = cargo metadata --no-deps --format-version 1 | ConvertFrom-Json
  Assert-LastExitCode "Lectura de metadata Cargo"
  $desktopCargoPackage = (
    $cargoMetadata.packages |
      Where-Object { $_.name -eq "framesync-desktop" } |
      Select-Object -First 1
  )
  $desktopCargoVersion = [string]$desktopCargoPackage.version

  $versions = @(
    [string]$desktopPackage.version,
    [string]$extensionPackage.version,
    [string]$tauriConfig.version,
    $desktopCargoVersion
  )
  if ($versions | Where-Object { $_ -ne $version }) {
    throw "Las versiones de package.json, desktop, extensión y tauri.conf.json no coinciden."
  }
  if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $passwordPath -PathType Leaf)) {
    throw "Falta la clave privada del updater en $keyDirectory."
  }

  if (-not $SkipChecks) {
    & $pnpm typecheck
    Assert-LastExitCode "Typecheck"
    & $pnpm test
    Assert-LastExitCode "Pruebas"
    cargo clippy --workspace --all-targets -- -D warnings
    Assert-LastExitCode "Clippy"
  }

  $privateKey = (Get-Content -Raw -LiteralPath $keyPath).Trim()
  $password = (Get-Content -Raw -LiteralPath $passwordPath).Trim([char]0xFEFF).Trim()
  try {
    $env:TAURI_SIGNING_PRIVATE_KEY = $privateKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password
    & $pnpm --filter "@framesync/desktop" tauri build --ci --bundles nsis
    Assert-LastExitCode "Build Tauri firmado"
  }
  finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  }

  $nsisDirectory = Join-Path $repositoryRoot "target\release\bundle\nsis"
  $installer = Get-ChildItem -LiteralPath $nsisDirectory -Filter "*_${version}_x64-setup.exe" |
    Select-Object -First 1
  if (-not $installer) {
    throw "No se encontró el instalador NSIS $version."
  }
  $signatureSource = "$($installer.FullName).sig"
  if (-not (Test-Path -LiteralPath $signatureSource -PathType Leaf)) {
    throw "No se generó la firma del updater: $signatureSource"
  }

  $assetDirectory = Join-Path $repositoryRoot "target\release\bundle\release-assets-$version"
  Assert-SafeReleasePath $assetDirectory
  New-Item -ItemType Directory -Force -Path $assetDirectory | Out-Null

  $installerName = "FrameSync_${version}_x64-setup.exe"
  $installerAsset = Join-Path $assetDirectory $installerName
  $signatureAsset = "$installerAsset.sig"
  Copy-Item -LiteralPath $installer.FullName -Destination $installerAsset -Force
  Copy-Item -LiteralPath $signatureSource -Destination $signatureAsset -Force

  $extensionSource = Join-Path $repositoryRoot "apps\extension\.output\chrome-mv3"
  $extensionAsset = Join-Path $assetDirectory "FrameSync-Capture_${version}.zip"
  Assert-SafeReleasePath $extensionAsset
  if (Test-Path -LiteralPath $extensionAsset) {
    Remove-Item -LiteralPath $extensionAsset -Force
  }
  Compress-Archive -Path (Join-Path $extensionSource "*") -DestinationPath $extensionAsset -CompressionLevel Optimal

  $signature = (Get-Content -Raw -LiteralPath $signatureAsset).Trim()
  $tag = "app-v$version"
  $downloadUrl = "https://github.com/$OwnerRepo/releases/download/$tag/$installerName"
  $manifest = [ordered]@{
    version = $version
    notes = $ReleaseNotes
    pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
      "windows-x86_64-nsis" = [ordered]@{
        signature = $signature
        url = $downloadUrl
      }
      "windows-x86_64" = [ordered]@{
        signature = $signature
        url = $downloadUrl
      }
    }
  }
  $latestPath = Join-Path $assetDirectory "latest.json"
  $json = $manifest | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText(
    $latestPath,
    $json,
    (New-Object System.Text.UTF8Encoding($false))
  )

  $checksums = @(
    Get-FileHash -Algorithm SHA256 -LiteralPath $installerAsset
    Get-FileHash -Algorithm SHA256 -LiteralPath $extensionAsset
  ) | ForEach-Object { "$($_.Hash.ToLowerInvariant())  $([System.IO.Path]::GetFileName($_.Path))" }
  $checksumsPath = Join-Path $assetDirectory "SHA256SUMS.txt"
  [System.IO.File]::WriteAllLines(
    $checksumsPath,
    $checksums,
    (New-Object System.Text.UTF8Encoding($false))
  )

  Write-Host "Release firmado listo: $assetDirectory"
  Write-Host "Tag esperado: $tag"
  Get-ChildItem -LiteralPath $assetDirectory |
    Select-Object Name, Length, LastWriteTime
}
finally {
  Pop-Location
}
