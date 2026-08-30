#!/usr/bin/env python3
"""Type keys into QEMU VM 102 via QMP. Runs on the Proxmox host."""
import json
import socket
import sys
import time

QMP = "/var/run/qemu-server/102.qmp"

SHIFT = {
    ":": "semicolon",
    "_": "minus",
    "%": "5",
    '"': "apostrophe",
    "(": "9",
    ")": "0",
    "@": "2",
    "&": "7",
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


def qcodes_for_char(ch: str):
    if ch in SHIFT:
        return ["shift", SHIFT[ch]]
    if ch in PLAIN:
        return [PLAIN[ch]]
    if ch.isupper():
        return ["shift", ch.lower()]
    if ch.isalnum():
        return [ch.lower()]
    raise SystemExit(f"no qcode for {ch!r}")


class Qmp:
    def __init__(self, path: str):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.settimeout(10)
        self.s.connect(path)
        self.buf = b""
        self.read_obj()
        self.cmd("qmp_capabilities")

    def read_obj(self):
        while True:
            if b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                if not line.strip():
                    continue
                return json.loads(line.decode())
            chunk = self.s.recv(4096)
            if not chunk:
                raise SystemExit("qmp closed")
            self.buf += chunk

    def cmd(self, execute: str, arguments=None):
        msg = {"execute": execute}
        if arguments is not None:
            msg["arguments"] = arguments
        self.s.sendall((json.dumps(msg) + "\n").encode())
        while True:
            obj = self.read_obj()
            if "error" in obj or "return" in obj:
                return obj

    def sendkey(self, *qcodes: str):
        keys = [{"type": "qcode", "data": k} for k in qcodes]
        res = self.cmd("send-key", {"keys": keys})
        if "error" in res:
            raise SystemExit(f"send-key {qcodes}: {res}")
        time.sleep(0.014)

    def type_text(self, text: str):
        for ch in text:
            self.sendkey(*qcodes_for_char(ch))


def screenshot(label: str):
    q = Qmp(QMP)
    path = f"/tmp/vm102-{label}.ppm"
    res = q.cmd("screendump", {"filename": path})
    q.s.close()
    print("screendump", label, res)


def run_dialog(q: Qmp, text: str):
    q.sendkey("esc")
    time.sleep(0.2)
    q.sendkey("meta_l", "d")
    time.sleep(0.5)
    q.sendkey("meta_l", "r")
    time.sleep(0.85)
    q.type_text(text)
    time.sleep(0.25)
    q.sendkey("tab")
    time.sleep(0.12)
    q.sendkey("spc")
    time.sleep(0.15)
    q.sendkey("ret")


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "copyrun"
    if action == "shot":
        screenshot(sys.argv[2] if len(sys.argv) > 2 else "now")
        return
    if action == "enter":
        q = Qmp(QMP)
        q.sendkey("ret")
        time.sleep(0.2)
        q.sendkey("kp_enter")
        q.s.close()
        print("enter sent")
        return

    commands = {
        "copyrun": r"cmd /c copy /y D:\SpaceTrash-Portable-0.1.0.exe %TEMP%\st.exe",
        "start": r"%TEMP%\st.exe",
        "http": r"http://192.168.0.249:8766/SpaceTrash-Portable-0.1.0.exe",
        "downloads": r"%USERPROFILE%\Downloads\SpaceTrash-Portable-0.1.0.exe",
        "runme": r"D:\RUN-ME.bat",
    }
    text = commands.get(action, action)
    q = Qmp(QMP)
    print("qmp ready")
    run_dialog(q, text)
    q.s.close()
    print("typed", text)


if __name__ == "__main__":
    main()
