#requires -Version 5.1
<#
  Sets the Basic-auth login/password for the DSH web gateway.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\set-password.ps1
    powershell -ExecutionPolicy Bypass -File .\set-password.ps1 -User admin

  The password is hashed with scrypt and written to
  %USERPROFILE%\.dsh\web-auth-proxy.auth.json.  The gateway reloads that file
  within ~5 seconds; no service restart is needed.
#>

param(
  [string]$User = 'admin',
  [string]$Password,
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
$authPath = Join-Path $DshHome 'web-auth-proxy.auth.json'
$hashTool = Join-Path $PSScriptRoot 'hash-password.cjs'

if (-not (Test-Path $hashTool)) {
  throw "hash-password.cjs not found next to set-password.ps1: $hashTool"
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw 'node.exe not found in PATH; install Node.js first.'
}
if (-not $User.Trim()) { throw 'Username must not be empty.' }

if (-not $Password) {
  $secure = Read-Host -AsSecureString ("Пароль для '" + $User + "'")
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $Password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if ($Password.Length -lt 8) {
  throw 'Пароль должен содержать минимум 8 символов.'
}

$env:DSH_NEW_PASSWORD = $Password
try {
  $json = & node.exe $hashTool $User
  if ($LASTEXITCODE -ne 0) { throw 'hash-password.cjs failed' }
} finally {
  Remove-Item Env:DSH_NEW_PASSWORD -ErrorAction SilentlyContinue
}

# Validate before replacing the live file.
$parsed = $json | ConvertFrom-Json
if ($parsed.user -ne $User) { throw 'hash tool returned an unexpected username' }
if (-not $parsed.salt -or -not $parsed.hash) { throw 'hash tool returned an incomplete record' }

New-Item -ItemType Directory -Force -Path $DshHome | Out-Null
$tmp = $authPath + '.tmp'
[IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
Move-Item -Force $tmp $authPath

# Restrict the file to the current user where icacls is available.
try {
  icacls $authPath /inheritance:r /grant:r ("{0}:(R,W)" -f $env:USERNAME) | Out-Null
} catch { }

Write-Host ("Логин/пароль сохранены: " + $authPath)
Write-Host 'Шлюз подхватит изменения в течение 5 секунд (перезапуск не нужен).'

# Give the gateway time to reload, then verify the new credentials locally.
Start-Sleep -Seconds 6
$pair = $User + ':' + $Password
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
try {
  $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -Headers @{ Authorization = 'Basic ' + $b64 } -UseBasicParsing -TimeoutSec 10
  Write-Host ("Проверка входа: HTTP " + [int]$response.StatusCode)
} catch {
  Write-Host ("Проверка входа не удалась: " + $_.Exception.Message)
  Write-Host 'Если шлюз ещё не запущен, это нормально — проверьте после старта DSH.'
}

if ($User -ne 'admin') {
  Write-Host 'Вы сменили логин: старые Basic-сессии в браузере нужно сбросить.'
}
Write-Host 'В браузере обновите страницу (Ctrl+F5). Если логин менялся — закройте вкладку и откройте заново.'
