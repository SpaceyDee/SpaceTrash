"""Launch SpaceTrash on Proxmox VM 102 via qemu sendkey (one SSH session)."""
import os
import sys
import time
import paramiko

VMID = "102"
HOST = "192.168.0.249"

SHIFT = {
    ":": "semicolon",
    "_": "minus",
    "%": "5",
    '"': "apostrophe",
    "(": "9",
    ")": "0",
    "@": "2",
}
PLAIN = {
    " ": "spc",
    "-": "minus",
    ".": "dot",
    "/": "slash",
    "\\": "backslash",
    "=": "equal",
    ",": "comma",
}


def to_qcode(ch: str) -> str:
    if ch in SHIFT:
        return f"shift-{SHIFT[ch]}"
    if ch in PLAIN:
        return PLAIN[ch]
    if ch.isupper():
        return f"shift-{ch.lower()}"
    if ch.isalnum():
        return ch.lower()
    raise SystemExit(f"no qcode for {ch!r}")


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        HOST,
        username="root",
        password=os.environ["PVE_PASS"],
        timeout=15,
        banner_timeout=15,
        auth_timeout=15,
        allow_agent=False,
        look_for_keys=False,
    )
    return c


def run(c, cmd, timeout=90):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def screenshot(c, label: str) -> str:
    remote = f"/tmp/vm102-{label}.ppm"
    code, out, err = run(
        c,
        f"rm -f {remote}; printf 'screendump {remote}\\n' | timeout 8 qm monitor {VMID}; "
        f"ls -la {remote} 2>&1; file {remote} 2>&1",
        timeout=20,
    )
    print(f"SHOT {label} code={code}\n{out}{err}")
    return remote


def main():
    # Shorter than a for-loop: ISO is almost always D: (ide2) with virtio on E:.
    cmd = r"cmd /c if exist D:\SpaceTrash-Portable-0.1.0.exe (start D:\SpaceTrash-Portable-0.1.0.exe) else if exist E:\SpaceTrash-Portable-0.1.0.exe (start E:\SpaceTrash-Portable-0.1.0.exe) else if exist F:\SpaceTrash-Portable-0.1.0.exe (start F:\SpaceTrash-Portable-0.1.0.exe)"
    if len(sys.argv) > 1:
        cmd = sys.argv[1]

    keys = ["esc", "ctrl-alt", "esc", "meta_l-r"]
    typed = [to_qcode(ch) for ch in cmd]
    keys.extend(typed)
    keys.append("ret")

    # Build a remote bash snippet that sendkeys with small delays.
    remote_lines = [
        "set -e",
        f"echo launching on vm {VMID}",
        "qm sendkey {v} esc; sleep 0.25".format(v=VMID),
        "qm sendkey {v} ctrl-alt; sleep 0.05".format(v=VMID),
        "qm sendkey {v} esc; sleep 0.35".format(v=VMID),
        "qm sendkey {v} meta_l-r; sleep 0.9".format(v=VMID),
    ]
    for q in typed:
        remote_lines.append(f"qm sendkey {VMID} {q}; sleep 0.03")
    remote_lines.append(f"qm sendkey {VMID} ret")
    remote_lines.append("echo sent")
    script = "\n".join(remote_lines)

    c = connect()
    print("connected")
    screenshot(c, "before")

    # Prefer sata0 first so a later reboot does not sit on the data ISO.
    code, out, err = run(c, "qm set 102 --boot order=sata0;ide2;ide3")
    print("boot-order", code, out, err)

    sftp = c.open_sftp()
    with sftp.file("/tmp/spacetrash-sendkeys.sh", "w") as f:
        f.write(script)
    sftp.close()
    code, out, err = run(c, "bash /tmp/spacetrash-sendkeys.sh", timeout=120)
    print("SEND", code)
    print(out)
    print(err)
    time.sleep(4)
    screenshot(c, "after")
    c.close()


if __name__ == "__main__":
    main()
