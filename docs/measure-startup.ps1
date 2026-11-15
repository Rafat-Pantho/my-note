# Cold-start and idle-memory measurement for the release exe (Windows).
#   npm run tauri -- build --no-bundle
#   powershell -NoProfile -File docs\measure-startup.ps1 -Runs 5
#   powershell -NoProfile -File docs\measure-startup.ps1 -Runs 5 -WebViewArgs "--disable-gpu"
# Prints the [timing] lines (MYNOTE_TIMING=1) plus the working set / private bytes of the whole process tree
# 6 s after launch. Each run starts a fresh process and kills it afterwards. It never touches your files.
param([int]$Runs = 5, [string]$WebViewArgs = "")
$exe = Join-Path $PSScriptRoot "..\src-tauri\target\release\my-note.exe"
$env:MYNOTE_TIMING = "1"
if ($WebViewArgs) { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $WebViewArgs }
else { Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue }
function Tree($rootPid) {
  $all = Get-CimInstance Win32_Process
  $ids = @($rootPid); $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and $ids -notcontains $p.ProcessId) { $ids += $p.ProcessId; $grew = $true } }
  }
  $ids
}
$out = [System.IO.Path]::GetTempFileName()
for ($i = 1; $i -le $Runs; $i++) {
  $p = Start-Process $exe -PassThru -RedirectStandardOutput $out
  Start-Sleep -Seconds 6
  $ids = Tree $p.Id
  $ws = 0; $priv = 0
  foreach ($id in $ids) { $q = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($q) { $ws += $q.WorkingSet64; $priv += $q.PrivateMemorySize64 } }
  Stop-Process -Id $p.Id -Force
  Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  $t = (Get-Content $out -Raw) -replace "`r?`n", " | "
  "run {0}: {1} procs={2} ws={3:N0}MB private={4:N0}MB" -f $i, $t, $ids.Count, ($ws / 1MB), ($priv / 1MB)
}
Remove-Item $out
