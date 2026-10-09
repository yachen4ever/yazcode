"""带 --enable-logging 启动，抓 renderer 的 console 输出（JS 异常会出现在 stderr）。"""
import subprocess, time

exe = r"C:\Users\YaCHEN\AppData\Local\Programs\yazcode\yazcode.exe"
proc = subprocess.Popen(
    [exe, "--disable-gpu", "--enable-logging", "--v=0"],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)
print("launched, waiting 35s ...", flush=True)
time.sleep(35)
alive = proc.poll() is None
print("alive:", alive, flush=True)
if alive:
    proc.terminate()
    time.sleep(3)
    if proc.poll() is None:
        proc.kill()

out, err = proc.communicate()
text = (out + b"\n---STDERR---\n" + err).decode("utf-8", errors="replace")
lines = text.splitlines()
# renderer 的 console 输出形如 "INFO:CONSOLE(...)" 或包含 [renderer]
interesting = [
    line[:260]
    for line in lines
    if ("CONSOLE" in line or "[renderer]" in line or "Uncaught" in line or "Error" in line)
]
print(f"--- 命中 {len(interesting)} 行 ---")
for line in interesting[-40:]:
    print(line)