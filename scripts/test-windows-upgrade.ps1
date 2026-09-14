param(
  [string]$Node = (Get-Command node -ErrorAction Stop).Source,
  [string]$Test = 'tests/windows-upgrade-e2e.mjs',
  [string]$CompletionFile,
  [switch]$ThroughTask
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$env:PSModulePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
$taskRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $taskRoot
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskElevated = ([Security.Principal.WindowsPrincipal]::new($taskIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# NSIS installs for the current user and launches the app without elevation.
# Hosted Windows runners are elevated; run the entire test with the same user
# and limited token so Explorer does not discard its isolated profile env.
if ($CompletionFile) {
  $taskExit = 1
  try {
    if ($taskElevated) { throw 'The installer test must run with a limited user token.' }
    $ErrorActionPreference = 'Continue'
    & $Node $Test *> "$CompletionFile.log"
    $taskExit = $LASTEXITCODE
  } catch {
    $_ | Out-String | Add-Content -LiteralPath "$CompletionFile.log"
  } finally {
    [IO.File]::WriteAllText("$CompletionFile.tmp", [string]$taskExit)
    [IO.File]::Move("$CompletionFile.tmp", $CompletionFile)
  }
  exit $taskExit
}
if (!$taskElevated -and !$ThroughTask) {
  & $Node $Test
  exit $LASTEXITCODE
}

function Quote-TaskValue([string]$Value) { "'" + $Value.Replace("'", "''") + "'" }
$taskLogs = Join-Path $taskRoot 'test-results\windows-installer'
$null = New-Item -ItemType Directory -Path $taskLogs -Force
$taskName = 'Portal-Installer-Test-' + [Guid]::NewGuid().ToString('N')
$taskResult = Join-Path $taskLogs "$taskName.exit"
$taskScript = ''
# Copy only test configuration, never the runner's complete environment.
foreach ($taskVariable in @('PORTAL_DESKTOP_UPDATE_REPOSITORY', 'PORTAL_DESKTOP_PACKAGE_OUT', 'PORTAL_DESKTOP_EXECUTABLE')) {
  $taskValue = [Environment]::GetEnvironmentVariable($taskVariable)
  if ($taskValue) { $taskScript += '$env:' + $taskVariable + '=' + (Quote-TaskValue $taskValue) + '; ' }
}
$taskScript += '& ' + (Quote-TaskValue $PSCommandPath) + ' -Node ' + (Quote-TaskValue $Node) + ' -Test ' + (Quote-TaskValue $Test) + ' -CompletionFile ' + (Quote-TaskValue $taskResult)
$taskEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskScript))
$taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $taskEncoded" -WorkingDirectory $taskRoot
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskIdentity.Name -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$null = Register-ScheduledTask -TaskName $taskName -Action $taskAction -Principal $taskPrincipal -Settings $taskSettings
try {
  Write-Output 'Running NSIS installation, automatic startup and Portal upgrade with a limited user token.'
  Start-ScheduledTask -TaskName $taskName
  $taskDeadline = [DateTime]::UtcNow.AddMinutes(14)
  while (!(Test-Path -LiteralPath $taskResult)) {
    if ([DateTime]::UtcNow -ge $taskDeadline) { throw 'The limited-user installer test timed out.' }
    Start-Sleep -Seconds 1
  }
  if (Test-Path -LiteralPath "$taskResult.log") { Get-Content -LiteralPath "$taskResult.log" }
  $taskExit = [int](Get-Content -LiteralPath $taskResult -Raw)
} finally {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
exit $taskExit
