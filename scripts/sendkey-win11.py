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


def connect():
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
    return c


def run(c, cmd, timeout=30):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def sendkey(c, key):
    run(c, f"qm sendkey {VMID} {key}")
    time.sleep(0.035)


def type_text(c, text):
    for ch in text:
        if ch in SHIFT:
            sendkey(c, f"shift-{SHIFT[ch]}")
        elif ch in PLAIN:
            sendkey(c, PLAIN[ch])
        elif ch.isupper():
            sendkey(c, f"shift-{ch.lower()}")
        elif ch.isalnum():
            sendkey(c, ch.lower())
        else:
            raise SystemExit(f"no qcode for {ch!r}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else (
        r'cmd /c for %d in (D E F G) do @if exist %d:\SpaceTrash-Portable-0.1.0.exe start %d:\SpaceTrash-Portable-0.1.0.exe'
    )
    c = connect()
    sendkey(c, "esc")
    time.sleep(0.3)
    sendkey(c, "ctrl-alt")
    sendkey(c, "esc")
    time.sleep(0.4)
    sendkey(c, "meta_l-r")
    time.sleep(1.0)
    print("TYPE", cmd)
    type_text(c, cmd)
    time.sleep(0.3)
    sendkey(c, "ret")
    c.close()
    print("sent")


if __name__ == "__main__":
    main()
