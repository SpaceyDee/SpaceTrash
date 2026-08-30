import os
import time
import paramiko
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BAT = r"""@echo off
setlocal
set DST=%TEMP%\SpaceTrash-Portable.exe
echo Copying SpaceTrash off the CD to TEMP...
if exist "%~d0\SpaceTrash-Portable-0.1.0.exe" copy /y "%~d0\SpaceTrash-Portable-0.1.0.exe" "%DST%" >nul
if not exist "%DST%" if exist "%~d0\SPACETRA.EXE" copy /y "%~d0\SPACETRA.EXE" "%DST%" >nul
if not exist "%DST%" (
  echo Copy failed. In Edge open:
  echo http://192.168.0.249:8766/SpaceTrash-Portable-0.1.0.exe
  pause
  exit /b 1
)
start "" "%DST%"
"""


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


def run(c, cmd, timeout=90):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    print(f">>> {cmd[:110]} => {code}")
    if out.strip():
        print(out)
    if err.strip():
        print(err)
    return code, out, err


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
    sftp = c.open_sftp()
    sftp.put(os.path.join(HERE, "qmp-type.py"), "/tmp/qmp-type.py")
    with sftp.file("/tmp/spacetrash-iso/RUN-ME.bat", "w") as f:
        f.write(BAT.replace("\n", "\r\n"))
    sftp.close()

    run(
        c,
        "which genisoimage mkisofs xorriso; "
        "(genisoimage -J -joliet-long -R -V SPACETRASH -o /var/lib/vz/template/iso/spacetrash-0.1.0.iso /tmp/spacetrash-iso "
        "|| mkisofs -J -joliet-long -R -V SPACETRASH -o /var/lib/vz/template/iso/spacetrash-0.1.0.iso /tmp/spacetrash-iso "
        "|| xorriso -as mkisofs -J -joliet-long -R -V SPACETRASH -o /var/lib/vz/template/iso/spacetrash-0.1.0.iso /tmp/spacetrash-iso)",
        timeout=60,
    )
    # quote boot/ide so bash does not split on semicolon
    run(c, "qm set 102 --ide2 'local:iso/spacetrash-0.1.0.iso,media=cdrom'")
    run(c, "mkdir -p /mnt/stiso; mount -o loop,ro /var/lib/vz/template/iso/spacetrash-0.1.0.iso /mnt/stiso; ls -la /mnt/stiso; umount /mnt/stiso")

    run(c, "python3 /tmp/qmp-type.py http")
    time.sleep(6)
    run(c, "python3 /tmp/qmp-type.py shot http")
    pull(c, "http")
    c.close()


if __name__ == "__main__":
    main()
