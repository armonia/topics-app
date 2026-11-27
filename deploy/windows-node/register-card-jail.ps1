# Registers and starts the card jail (card-jail.ps1) as the "topics-card-jail" task:
# at BOOT with no logon (S4U, no password), no window, same user as the card CLIs, elevated:
# processes born from ssh are elevated and a Limited job cannot open them (OpenProcess 5).
param([string]$Dir = $(if ($env:TOPICS_NODE_DIR) { $env:TOPICS_NODE_DIR } else { "C:\topics-node" }))
$u = "$env:COMPUTERNAME\$env:USERNAME"
$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo $Dir\run-hidden.vbs powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Dir\card-jail.ps1 -Log $Dir\logs\card-jail.log"
$t = New-ScheduledTaskTrigger -AtStartup
$pr = New-ScheduledTaskPrincipal -UserId $u -LogonType S4U -RunLevel Highest
$st = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'topics-card-jail' -Action $a -Trigger $t -Principal $pr -Settings $st -Force | Out-Null
# Start only if it is not already running (two jails would fight over the CLIs).
if (-not (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ? CommandLine -like '*card-jail.ps1*')) { Start-ScheduledTask -TaskName 'topics-card-jail' }
'registered'
