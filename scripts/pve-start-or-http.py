import os
import time
import paramiko
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))


def connect():
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
    return c


def run(c, cmd, timeout=40):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    print(f">>> {cmd[:90]} => {code}")
    if out.strip():
        print(out)
    if err.strip():
        print(err)
    return code


def pull(c, label):
    sftp = c.open_sftp()
    ppm = os.path.join(HERE, f"vm102-{label}.ppm")
    sftp.get(f"/tmp/vm102-{label}.ppm", ppm)
    sftp.close()
    im = Image.open(ppm)
    im.save(os.path.join(HERE, f"vm102-{label}.png"))
    print("png", label, im.size)


def main():
    c = connect()
    run(c, "python3 /tmp/qmp-type.py start")
    time.sleep(8)
    run(c, "python3 /tmp/qmp-type.py shot started")
    pull(c, "started")
    c.close()


if __name__ == "__main__":
    main()
