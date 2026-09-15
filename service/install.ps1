#Requires -RunAsAdministrator
<#
  Installs Subtitle Sync as a Windows service that starts with the PC.

  Run from an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File service\install.ps1

  Safe to run again after pulling changes: it rebuilds, reinstalls and restarts.
#>
param(
  # node.exe the service runs. Defaults to the one on PATH.
  [string]$Node = (Get-Command node -ErrorAction Stop).Source
)

$ErrorActionPreference = 'Stop'
$Name = 'SubtitleSync'
$Account = "NT SERVICE\$Name"
$Root = Split-Path $PSScriptRoot -Parent
$Bin = Join-Path $PSScriptRoot 'bin'
$Exe = Join-Path $Bin 'SubtitleSyncService.exe'
$Logs = Join-Path $Root 'logs'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

# The port comes from .env, like the server itself reads it.
$Port = 7000
$envFile = Join-Path $Root '.env'
if (Test-Path $envFile) {
  $line = Get-Content $envFile | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)\s*$' } | Select-Object -First 1
  if ($line -match '(\d+)') { $Port = [int]$Matches[1] }
}

$existing = Get-Service $Name -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') {
  Step "Stopping the running service"
  Stop-Service $Name -Force
}

# Anything else on the port, usually `npm run dev`, would make the service fail to start.
$holder = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($holder) {
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($holder.OwningProcess)").CommandLine
  throw "Port $Port is in use by process $($holder.OwningProcess) ($cmd). Stop it first, for example the terminal running 'npm run dev'."
}

Step "Building the server"
Push-Location $Root
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} finally {
  Pop-Location
}

Step "Compiling the service wrapper"
$csc = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework64\v4*\csc.exe" | Select-Object -Last 1
if (-not $csc) { throw "The .NET Framework 4 C# compiler was not found." }
New-Item -ItemType Directory -Force -Path $Bin, $Logs | Out-Null
& $csc.FullName /nologo /target:exe /platform:x64 /optimize "/out:$Exe" /reference:System.ServiceProcess.dll (Join-Path $PSScriptRoot 'SubtitleSyncService.cs')
if ($LASTEXITCODE -ne 0) { throw "Compiling the service wrapper failed" }

if (-not $existing) {
  Step "Creating the service"
  $binPath = "`"$Exe`" --node `"$Node`" --dir `"$Root`""
  New-Service -Name $Name -BinaryPathName $binPath -DisplayName 'Subtitle Sync (Stremio addon)' `
    -Description 'Stremio subtitles addon that syncs subtitles to your video. Serves http://<this PC>:7000.' `
    -StartupType Automatic | Out-Null
} else {
  Step "Updating the existing service"
  $binPath = "`"$Exe`" --node `"$Node`" --dir `"$Root`""
  # PathName is read-only as a property; the Change method is how it is updated.
  $changed = Invoke-CimMethod -ClassName Win32_Service -Filter "Name = '$Name'" -MethodName Change -Arguments @{ PathName = $binPath }
  if ($changed.ReturnValue -ne 0) { throw "Updating the service command failed (code $($changed.ReturnValue))" }
}

# Delayed start, so the network is up before the addon is.
sc.exe config $Name start= delayed-auto | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Setting delayed automatic start failed" }

# Its own virtual account: no password, and only the rights granted below.
sc.exe config $Name obj= $Account | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Setting the service account failed" }

# If the wrapper itself fails, Windows starts it again.
sc.exe failure $Name reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null

Step "Granting $Account read access to the project and write access to logs\"
icacls $Root /grant "${Account}:(OI)(CI)RX" /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Granting read access failed" }
icacls $Logs /grant "${Account}:(OI)(CI)M" /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Granting write access to logs failed" }

Step "Starting the service"
Start-Service $Name

$healthy = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    if ($response.StatusCode -eq 200) { $healthy = $true; break }
  } catch { }
}

Get-Service $Name | Format-Table Name, Status, StartType -AutoSize
if ($healthy) {
  Write-Host "Subtitle Sync is running on port $Port and starts with Windows." -ForegroundColor Green
} else {
  Write-Host "The service started, but http://127.0.0.1:$Port/health did not answer. Last lines of logs\service.log:" -ForegroundColor Yellow
  Get-Content (Join-Path $Logs 'service.log') -Tail 20 -ErrorAction SilentlyContinue
  exit 1
}
