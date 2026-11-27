# Updates the Topics node to the given version and restarts it. Launched by the scheduled task
# "topics-node-update" (Interactive, created by node-prep): over ssh the NSIS installer fails silently.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Dir = $(if ($env:TOPICS_NODE_DIR) { $env:TOPICS_NODE_DIR } else { "C:\topics-node" })
)
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Dir\install-node.ps1" -Version $Version -Dir $Dir
$rc = $LASTEXITCODE
# install-node.ps1 stops topics-server: the node restarts from its task, updated or not.
Start-ScheduledTask -TaskName "topics-node"
"$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) update $Version exit $rc" | Add-Content "$Dir\logs\update.log"
exit $rc
