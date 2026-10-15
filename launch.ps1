# Desktop launcher for BioStore.
# Starts the local server if it is not already up, then opens the browser.
# Closing the "BioStore" console window stops the server.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

$url = "http://127.0.0.1:8765"

function Test-BioStoreUp {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$url/api/stats"
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Show-LaunchError([string]$message) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        $message,
        "BioStore",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

if (Test-BioStoreUp) {
    Start-Process $url
    exit 0
}

$flaskOk = $false
try {
    py -c "import flask" 2>$null
    if ($LASTEXITCODE -eq 0) { $flaskOk = $true }
} catch {
    $flaskOk = $false
}

if (-not $flaskOk) {
    py -m pip install -q -r "$root\backend\requirements.txt"
    if ($LASTEXITCODE -ne 0) {
        Show-LaunchError "Could not install BioStore's Python dependencies. Open a terminal in the BioStore folder and run: py -m pip install -r backend\requirements.txt"
        exit 1
    }
}

# A titled console stays on the taskbar so the server can be stopped by closing it.
Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/k", "title BioStore && py -u run.py" `
    -WorkingDirectory $root `
    -WindowStyle Minimized

$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
    if (Test-BioStoreUp) {
        Start-Process $url
        exit 0
    }
    Start-Sleep -Milliseconds 400
}

Show-LaunchError "BioStore did not respond at $url. Check the minimized BioStore console window for an error."
exit 1
