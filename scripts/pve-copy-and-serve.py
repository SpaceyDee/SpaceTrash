import os
import time
import paramiko
from PIL import Image

HOST = "192.168.0.249"
HERE = os.path.dirname(os.path.abspath(__file__))


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        HOST,
        username="root",
        password=os.environ["PVE_PASS"],
        timeout=15,
        allow_agent=False,
        look_for_keys=False,
    )
    return c


def run(c, cmd, timeout=60):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    print(f">>> {cmd[:100]} => {code}")
    if out.strip():
        print(out)
    if err.strip():
        print(err)
    return code, out, err


HTTP = r"""#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import os
os.chdir("/tmp/spacetrash-iso")
class H(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()
ThreadingHTTPServer(("0.0.0.0", 8766), H).serve_forever()
"""


def pull_shot(c, label):
    sftp = c.open_sftp()
    local_ppm = os.path.join(HERE, f"vm102-{label}.ppm")
    sftp.get(f"/tmp/vm102-{label}.ppm", local_ppm)
    sftp.close()
    im = Image.open(local_ppm)
    png = os.path.join(HERE, f"vm102-{label}.png")
    im.save(png)
    print("png", label, im.size)
    return png


def main():
    c = connect()
    sftp = c.open_sftp()
    sftp.put(os.path.join(HERE, "qmp-type.py"), "/tmp/qmp-type.py")
    with sftp.file("/tmp/spacetrash-http.py", "w") as f:
        f.write(HTTP)
    sftp.close()

    run(c, "pkill -f /tmp/spacetrash-http.py || true")
    run(
        c,
        "nohup python3 /tmp/spacetrash-http.py >/tmp/spacetrash-http.log 2>&1 & "
        "sleep 0.4; ss -lntp | grep 8766; curl -sI http://127.0.0.1:8766/SpaceTrash-Portable-0.1.0.exe | head -8",
    )

    run(c, "python3 /tmp/qmp-type.py enter")
    time.sleep(0.5)
    run(c, "python3 /tmp/qmp-type.py copyrun")
    print("waiting for CD copy...")
    time.sleep(22)
    run(c, "python3 /tmp/qmp-type.py shot copy")
    pull_shot(c, "copy")
    c.close()


if __name__ == "__main__":
    main()
