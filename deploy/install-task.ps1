#requires -Version 5.1
<#
  Registers (or replaces) the logon task that keeps the DSH web stack alive.

  Must run from an elevated PowerShell: the task itself needs the highest
  privileges to maintain the netsh portproxy rule.
#>

param(
  [string]$TaskName = 'DSH Web Auth Gateway',
  [string]$Supervisor = (Join-Path $env:USERPROFILE '.dsh\web-auth-supervisor.ps1')
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated PowerShell (Запустить от имени администратора).'
}
if (-not (Test-Path $Supervisor)) {
  throw "Supervisor script not found: $Supervisor"
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershell `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Supervisor + '"')

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT10S'

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 1
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

$task = Get-ScheduledTask -TaskName $TaskName
Write-Host ("Задача '" + $TaskName + "': " + $task.State)
Write-Host 'Триггер: вход пользователя в Windows, задержка 10 секунд.'
Write-Host ("Проверить: Get-ScheduledTaskInfo -TaskName '" + $TaskName + "'")
