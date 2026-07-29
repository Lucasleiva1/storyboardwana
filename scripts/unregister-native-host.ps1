[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = "Stop"
$hostName = "com.framesync.capture"
$registryPaths = @(
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
)
$manifestPath = Join-Path $env:LOCALAPPDATA "FrameSync\native-host\$hostName.json"

foreach ($registryPath in $registryPaths) {
  if (Test-Path -LiteralPath $registryPath) {
    if ($PSCmdlet.ShouldProcess($registryPath, "Eliminar registro de Native Messaging")) {
      Remove-Item -LiteralPath $registryPath -Force
    }
  }
}

if (Test-Path -LiteralPath $manifestPath) {
  if ($PSCmdlet.ShouldProcess($manifestPath, "Eliminar manifest generado")) {
    Remove-Item -LiteralPath $manifestPath -Force
  }
}

Write-Host "FrameSync Native Messaging Host fue desregistrado."
