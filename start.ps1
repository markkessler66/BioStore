# BioStore launcher for Windows PowerShell.
# Usage:  ./start.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host "Ensuring Flask is installed..." -ForegroundColor Cyan
py -m pip install -q -r "$root/backend/requirements.txt"

Write-Host "Starting BioStore on http://127.0.0.1:8765" -ForegroundColor Green
py "$root/run.py"
