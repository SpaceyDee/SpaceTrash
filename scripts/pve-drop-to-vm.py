"""Put SpaceTrash on a CD + a small FAT disk attached to VM 102."""
import os
import time

import paramiko

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = "192.168.0.249"

REMOTE_SH = r"""
set -e
ISO_DIR=/tmp/spacetrash-iso
IMG=/var/lib/vz/images/102/spacetrash-drop.raw
MNT=/mnt/stdrop
mkdir -p "$ISO_DIR" /var/lib/vz/images/102 "$MNT"

# Rebuild ISO with Joliet so Windows sees the long filename.
genisoimage -J -joliet-long -R -V SPACETRASH \
  -o /var/lib/vz/template/iso/spacetrash-0.1.0.iso "$ISO_DIR"

# Writable FAT disk Windows can copy from.
umount "$MNT" 2>/dev/null || true
qemu-img create -f raw "$IMG" 128M
mkfs.vfat -n SPACETRASH -F 32 "$IMG"
mount -o loop "$IMG" "$MNT"
cp -f "$ISO_DIR"/* "$MNT"/
sync
ls -la "$MNT"
umount "$MNT"

# Attach FAT disk if not already present.
if ! qm config 102 | grep -q 'sata1:'; then
  qm set 102 --sata1 local:102/spacetrash-drop.raw,backup=0
else
  qm set 102 --sata1 local:102/spacetrash-drop.raw,backup=0
fi

# Force the running VM to see the new ISO (config can lag the live CD).
qm set 102 --ide2 local:iso/spacetrash-0.1.0.iso,media=cdrom
printf 'eject ide2\nchange ide2 /var/lib/vz/template/iso/spacetrash-0.1.0.iso\n' | timeout 8 qm monitor 102 || true

echo '---CONFIG---'
qm config 102 | grep -E 'ide2|sata1'
echo DONE
"""


def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        HOST,
        username="root",
        password=os.environ["PVE_PASS"],
        timeout=20,
        allow_agent=False,
        look_for_keys=False,
    )
    sftp = c.open_sftp()
    def put_text(local, remote, crlf=False):
        data = open(local, "rb").read()
        if crlf:
            data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        with sftp.file(remote, "wb") as f:
            f.write(data)

    put_text(os.path.join(HERE, "COPY-TO-DESKTOP.bat"), "/tmp/spacetrash-iso/COPY-TO-DESKTOP.bat", True)
    put_text(os.path.join(HERE, "README-COPY.txt"), "/tmp/spacetrash-iso/README-COPY.txt", True)
    put_text(os.path.join(HERE, "COPY-TO-DESKTOP.bat"), "/tmp/spacetrash-iso/COPYTODE.BAT", True)
    with sftp.file("/tmp/spacetrash-drop.sh", "w") as f:
        f.write(REMOTE_SH)
    sftp.close()
    print("uploaded payload")
    stdin, stdout, stderr = c.exec_command("bash /tmp/spacetrash-drop.sh", timeout=120)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    print(out)
    if err:
        print(err)
    print("exit", code)
    c.close()
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
