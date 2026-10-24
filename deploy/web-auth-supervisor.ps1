#requires -Version 5.1
<#
  DSH Web auth gateway supervisor.

  Keeps the public chain alive:
    <your-domain> (TLS, OpenResty) -> <LAN-IP>:3080
      -> netsh portproxy -> 127.0.0.1:3099 (Basic auth gateway)
      -> 127.0.0.1:3081 (DSH web, reserve / direct local listener)

  Started at logon by the "DSH Web Auth Gateway" scheduled task.
  Safe to run repeatedly: only one instance keeps the lock, and each missing
  piece is started by its listening port.
#>

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$HomeDir = $env:USERPROFILE
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HomeDir '.dsh' }
$LogFile = Join-Path $DshHome 'web-stack-supervisor.log'
$LockFile = Join-Path $DshHome 'web-stack-supervisor.pid'
$GatewayScript = Join-Path $DshHome 'web-auth-proxy.cjs'
$GatewayOut = Join-Path $DshHome 'web-auth-proxy.out.log'
$GatewayErr = Join-Path $DshHome 'web-auth-proxy.err.log'
$DshOut = Join-Path $DshHome 'web-live.log'
$DshErr = Join-Path $DshHome 'web-live.err.log'
$Workspace = Join-Path $HomeDir 'Documents\deepseek-harness\default-workspace'
$NodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { $NodeExe = 'C:\Program Files\nodejs\node.exe' }

function Write-Log([string]$Message) {
  try {
    if (Test-Path $LogFile) {
      $size = (Get-Item $LogFile).Length
      if ($size -gt 2MB) { Move-Item -Force $LogFile ($LogFile + '.1') }
    }
    Add-Content -Path $LogFile -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
  } catch { }
}

function Test-LocalPort([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch { }
  }
}

function Get-ListenerPid([int]$Port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
  } catch { }
  return 0
}

function Get-DshBin {
  # A dedicated runtime under the harness home is the most stable choice:
  # it survives npm's _npx cache cleanup and version switches.
  $dedicated = Join-Path $DshHome 'runtime\node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (Test-Path $dedicated) { return $dedicated }

  # A global npm install, if present.
  $global = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (Test-Path $global) { return $global }

  $candidates = @()
  foreach ($base in @((Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'), (Join-Path $HomeDir 'AppData\Local\npm-cache\_npx'))) {
    if (Test-Path $base) {
      $candidates += Get-ChildItem $base -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'
      } | Where-Object { Test-Path $_ }
    }
  }
  $candidates = $candidates | Sort-Object { (Get-Item $_).LastWriteTime } -Descending
  if ($candidates.Count -gt 0) { return $candidates[0] }
  return $null
}

function Ensure-PortProxy {
  $expected = '0.0.0.0\s+3080\s+127\.0\.0\.1\s+3099'
  $output = & netsh interface portproxy show v4tov4 2>&1 | Out-String
  if ($output -match $expected) { return }
  Write-Log 'portproxy 3080 -> 3099 missing; adding'
  $add = & netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3080 connectaddress=127.0.0.1 connectport=3099 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Write-Log ("portproxy add failed (needs administrator?): " + $add.Trim())
  } else {
    Write-Log 'portproxy 3080 -> 3099 added'
  }
}

function Stop-StaleGateway {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'web-auth-proxy\.cjs' }
  foreach ($p in $procs) {
    $age = ((Get-Date) - $p.CreationDate).TotalSeconds
    if ($age -gt 30) {
      Write-Log ("stopping stale gateway process pid " + $p.ProcessId + " age " + [int]$age + "s")
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-Gateway {
  if (-not (Test-Path $GatewayScript)) {
    Write-Log "gateway script missing: $GatewayScript"
    return
  }
  try {
    $p = Start-Process -FilePath $NodeExe -ArgumentList ('"' + $GatewayScript + '"') -WorkingDirectory $DshHome `
      -WindowStyle Hidden -RedirectStandardOutput $GatewayOut -RedirectStandardError $GatewayErr -PassThru
    Write-Log ("gateway start requested, pid " + $p.Id)
  } catch {
    Write-Log ("gateway start failed: " + $_.Exception.Message)
  }
}

function Start-Dsh {
  $dshBin = Get-DshBin
  if (-not $dshBin) {
    Write-Log 'cannot locate @deepseek-ai/dsh/lib/bin.js'
    return
  }
  try {
    $args = @('"' + $dshBin + '"', 'web', '--port', '3081', '--no-open')
    $p = Start-Process -FilePath $NodeExe -ArgumentList $args -WorkingDirectory $Workspace `
      -WindowStyle Hidden -RedirectStandardOutput $DshOut -RedirectStandardError $DshErr -PassThru
    Write-Log ("DSH start requested, pid " + $p.Id + " bin " + $dshBin)
  } catch {
    Write-Log ("DSH start failed: " + $_.Exception.Message)
  }
}

# ---- single instance -------------------------------------------------
$takeLock = $true
if (Test-Path $LockFile) {
  $oldPid = 0
  try { $oldPid = [int](Get-Content $LockFile -ErrorAction Stop | Select-Object -First 1) } catch { }
  if ($oldPid -gt 0) {
    $old = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($old -and $old.ProcessName -eq 'powershell') {
      $oldCmd = ''
      try { $oldCmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid" -ErrorAction Stop).CommandLine } catch { }
      if ($oldCmd -match 'web-auth-supervisor\.ps1') { $takeLock = $false }
    }
  }
}
if (-not $takeLock) { exit 0 }
Set-Content -Path $LockFile -Value $PID -Encoding ASCII

Write-Log 'supervisor starting'
Write-Log ("node=" + $NodeExe)
Write-Log ("dshBin=" + (Get-DshBin))
if (-not (Test-Path $NodeExe)) { Write-Log ("node executable missing: " + $NodeExe) }

$lastDshAttempt = [datetime]::MinValue
$lastGatewayAttempt = [datetime]::MinValue
$lastPortProxyCheck = [datetime]::MinValue
$lastDshState = $null
$lastGatewayState = $null

try {
  Ensure-PortProxy

  while ($true) {
    if (((Get-Date) - $lastPortProxyCheck).TotalSeconds -gt 60) {
      Ensure-PortProxy
      $lastPortProxyCheck = Get-Date
    }

    $dshUp = Test-LocalPort 3081
    if ($dshUp -ne $lastDshState) {
      Write-Log ("DSH 3081 " + $(if ($dshUp) { 'listening' } else { 'down' }))
      $lastDshState = $dshUp
    }
    if (-not $dshUp -and ((Get-Date) - $lastDshAttempt).TotalSeconds -gt 60) {
      Start-Dsh
      $lastDshAttempt = Get-Date
      Start-Sleep -Seconds 2
    }

    $gatewayUp = Test-LocalPort 3099
    if ($gatewayUp -ne $lastGatewayState) {
      Write-Log ("gateway 3099 " + $(if ($gatewayUp) { 'listening' } else { 'down' }))
      $lastGatewayState = $gatewayUp
    }
    if (-not $gatewayUp -and ((Get-Date) - $lastGatewayAttempt).TotalSeconds -gt 20) {
      Stop-StaleGateway
      Start-Gateway
      $lastGatewayAttempt = Get-Date
      Start-Sleep -Seconds 1
    }

    Start-Sleep -Seconds 10
  }
} finally {
  try { Remove-Item -Force $LockFile -ErrorAction SilentlyContinue } catch { }
  Write-Log 'supervisor stopped'
}
