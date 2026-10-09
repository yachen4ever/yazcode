"""列出所有 yazcode 相关进程的完整命令行与监听端口。"""
import subprocess, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
out = subprocess.run(
    ["wmic", "process", "where", "name='yazcode.exe'", "get", "ProcessId,CommandLine", "/format:list"],
    capture_output=True,
).stdout.decode("utf-8", errors="replace")

blocks = [b for b in out.split("\n\n") if "ProcessId" in b]
for block in blocks:
    lines = dict(
        line.split("=", 1) for line in block.strip().splitlines() if "=" in line
    )
    pid = lines.get("ProcessId", "?")
    cmd = lines.get("CommandLine", "?")
    # 只显示关键部分：主进程 or renderer/utility 类型参数
    short = cmd if len(cmd) <= 160 else ("[main] " if "--type=" not in cmd else cmd[cmd.index("--type="):][:120])
    print(f"pid={pid}: {short}")

print("\n--- 监听端口（yazcode pid 段）---")
netstat = subprocess.run(["netstat", "-ano"], capture_output=True).stdout.decode("utf-8", errors="replace")
pids = {lines.get("ProcessId") for lines in (dict(l.split("=", 1) for l in b.strip().splitlines() if "=" in l) for b in blocks)}
for line in netstat.splitlines():
    parts = line.split()
    if len(parts) >= 5 and parts[3] == "LISTENING" and parts[4] in pids:
        print(f"  {parts[1]} <- pid {parts[4]}")