$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$stdoutLog = Join-Path $projectRoot ".dev-tauri.stdout.log"
$stderrLog = Join-Path $projectRoot ".dev-tauri.stderr.log"
$processName = "framesync-desktop"
$desktopExecutable = Join-Path $projectRoot "target\debug\framesync-desktop.exe"

function Show-StoryboardWanaWindow {
    $shell = New-Object -ComObject WScript.Shell
    return $shell.AppActivate("Storyboard Wana")
}

if (
    Get-Process -Name $processName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 }
) {
    Show-StoryboardWanaWindow | Out-Null
    exit 0
}

Get-Process -Name $processName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -eq 0 } |
    Stop-Process -Force

if (Test-Path -LiteralPath $desktopExecutable) {
    Start-Process `
        -FilePath $desktopExecutable `
        -WorkingDirectory $projectRoot
} else {
    Start-Process `
        -FilePath "pnpm.cmd" `
        -ArgumentList @("dev:desktop") `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog
}

$deadline = (Get-Date).AddMinutes(3)
while ((Get-Date) -lt $deadline) {
    if (Get-Process -Name $processName -ErrorAction SilentlyContinue) {
        Start-Sleep -Milliseconds 750
        Show-StoryboardWanaWindow | Out-Null
        exit 0
    }

    Start-Sleep -Milliseconds 750
}

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show(
    "No se pudo iniciar Storyboard Wana. Revisa los archivos .dev-tauri.*.log dentro del proyecto.",
    "Storyboard Wana",
    "OK",
    "Error"
) | Out-Null
exit 1
