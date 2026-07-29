[CmdletBinding()]
param(
  [ValidatePattern("^[a-p]{32}$")]
  [string]$ExpectedExtensionId = "kdmgiohkeeehnpaccfmjgiccfbaodlhg"
)

$ErrorActionPreference = "Stop"
$hostName = "com.framesync.capture"
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

if (-not (Test-Path -LiteralPath $registryPath)) {
  throw "Chrome no encuentra el registro HKCU del host. Ejecutá register-native-host.ps1."
}

$manifestPath = (Get-Item -LiteralPath $registryPath).GetValue("")
if ([string]::IsNullOrWhiteSpace($manifestPath) -or -not (Test-Path -LiteralPath $manifestPath)) {
  throw "El registro existe, pero apunta a un manifest ausente: $manifestPath"
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.name -ne $hostName) {
  throw "El nombre del manifest no coincide con $hostName."
}
if (-not (Test-Path -LiteralPath $manifest.path -PathType Leaf)) {
  throw "El ejecutable configurado no existe: $($manifest.path)"
}

$expectedOrigin = "chrome-extension://$ExpectedExtensionId/"
if ($manifest.allowed_origins -notcontains $expectedOrigin) {
  throw "El origen permitido no coincide. Esperado: $expectedOrigin"
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $manifest.path
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) {
  throw "No se pudo iniciar el host nativo."
}

$request = @{
  protocolVersion = 1
  type = "ping"
  requestId = "powershell-verify"
} | ConvertTo-Json -Compress
$requestBytes = [System.Text.Encoding]::UTF8.GetBytes($request)
$lengthBytes = [System.BitConverter]::GetBytes([uint32]$requestBytes.Length)

$process.StandardInput.BaseStream.Write($lengthBytes, 0, $lengthBytes.Length)
$process.StandardInput.BaseStream.Write($requestBytes, 0, $requestBytes.Length)
$process.StandardInput.BaseStream.Flush()

$responseLengthBytes = New-Object byte[] 4
$readLength = $process.StandardOutput.BaseStream.Read($responseLengthBytes, 0, 4)
if ($readLength -ne 4) {
  $errorText = $process.StandardError.ReadToEnd()
  throw "El host no devolvió un frame válido. $errorText"
}
$responseLength = [System.BitConverter]::ToUInt32($responseLengthBytes, 0)
if ($responseLength -gt 1048576) {
  throw "La respuesta excede el límite de Chrome."
}

$responseBytes = New-Object byte[] $responseLength
$offset = 0
while ($offset -lt $responseLength) {
  $count = $process.StandardOutput.BaseStream.Read(
    $responseBytes,
    $offset,
    $responseLength - $offset
  )
  if ($count -le 0) { throw "El host cerró stdout antes de completar la respuesta." }
  $offset += $count
}
$process.StandardInput.Close()
$response = [System.Text.Encoding]::UTF8.GetString($responseBytes) | ConvertFrom-Json

if (-not $response.ok -or $response.code -ne "OK") {
  throw "El host respondió con error: $($response.message)"
}

Write-Host "Native Messaging OK"
Write-Host "Host: $($response.data.host)"
Write-Host "Protocolo: $($response.data.protocolVersion)"
Write-Host "Spool: $($response.data.spoolRoot)"

