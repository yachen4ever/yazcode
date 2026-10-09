"""读 Windows Error Reporting 事件，找崩溃的应用名与故障模块。"""
import subprocess, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
ps = r"""
Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Windows Error Reporting'; StartTime=(Get-Date).AddHours(-3)} -MaxEvents 4 -ErrorAction SilentlyContinue |
  ForEach-Object {
    $m = $_.Message
    $lines = $m -split "`r?`n"
    $pick = $lines | Where-Object { $_ -match '^(P1|P2|P4|P5|P7|P8):' } | Select-Object -First 6
    "TIME=" + $_.TimeCreated.ToString("HH:mm:ss")
    $pick | ForEach-Object { "  " + $_ }
  }
"""
r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True)
print(r.stdout.decode("utf-8", errors="replace"))
err = r.stderr.decode("utf-8", errors="replace")
if err.strip():
    print("stderr:", err[:300])