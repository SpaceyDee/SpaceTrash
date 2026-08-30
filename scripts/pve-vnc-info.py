"""Check Proxmox VNC proxy for VM 102. Never prints ticket or password."""
import json
import os
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(
    "192.168.0.249",
    username="root",
    password=os.environ["PVE_PASS"],
    timeout=15,
    allow_agent=False,
    look_for_keys=False,
)
stdin, stdout, stderr = c.exec_command(
    "pvesh create /nodes/pve01/qemu/102/vncproxy --output-format json",
    timeout=30,
)
out = stdout.read().decode("utf-8", "replace")
err = stderr.read().decode("utf-8", "replace")
code = stdout.channel.recv_exit_status()
c.close()

if code != 0:
    raise SystemExit(f"vncproxy failed ({code})")

data = json.loads(out)
print("port", data.get("port"))
print("user", data.get("user"))
print("has_ticket", bool(data.get("ticket") or data.get("password")))
print("keys", sorted(data.keys()))
if err.strip():
    print("stderr-len", len(err))
