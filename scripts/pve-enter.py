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
sftp = c.open_sftp()
sftp.put(os.path.join(os.path.dirname(__file__), "qmp-type.py"), "/tmp/qmp-type.py")
sftp.close()
stdin, stdout, stderr = c.exec_command("python3 /tmp/qmp-type.py enter", timeout=20)
print(stdout.read().decode())
print(stderr.read().decode())
c.close()
