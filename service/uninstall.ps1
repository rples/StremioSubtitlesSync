#Requires -RunAsAdministrator
<#
  Removes the Subtitle Sync Windows service and the folder permissions it was given.

  Run from an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File service\uninstall.ps1
#>
$ErrorActionPreference = 'Stop'
$Name = 'SubtitleSync'
$Account = "NT SERVICE\$Name"
$Root = Split-Path $PSScriptRoot -Parent
$Logs = Join-Path $Root 'logs'

$service = Get-Service $Name -ErrorAction SilentlyContinue
if (-not $service) {
  Write-Host "The $Name service is not installed."
  exit 0
}

if ($service.Status -ne 'Stopped') {
  Write-Host "==> Stopping the service" -ForegroundColor Cyan
  Stop-Service $Name -Force
}

# The account only resolves while its service exists, so remove its rights first.
Write-Host "==> Removing the permissions of $Account" -ForegroundColor Cyan
icacls $Root /remove:g $Account /Q | Out-Null
if (Test-Path $Logs) { icacls $Logs /remove:g $Account /Q | Out-Null }

Write-Host "==> Deleting the service" -ForegroundColor Cyan
sc.exe delete $Name | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Deleting the service failed" }

Write-Host "The $Name service is removed. Logs stay in logs\." -ForegroundColor Green
