param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
try {
  $running = @(Get-CimInstance Win32_Process -Filter "Name='portal-desktop.exe'" | Where-Object {
    $_.ExecutablePath -eq $Executable -and $_.CommandLine -notmatch '--type='
  })
  if ($running.Count -eq 0) { exit 0 }
  $null = Start-Process -FilePath $Executable -ArgumentList "--prepare-installer=$Version" -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(120)
  do {
    $remaining = @(Get-CimInstance Win32_Process -Filter "Name='portal-desktop.exe'" | Where-Object { $_.ExecutablePath -eq $Executable })
    if ($remaining.Count -eq 0) { exit 0 }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw 'The previous client did not finish shutting down.'
} catch { [Console]::Error.WriteLine($_); exit 1 }
