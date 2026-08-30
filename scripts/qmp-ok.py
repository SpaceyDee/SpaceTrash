#!/usr/bin/env python3
import json
import socket
import time

QMP = "/var/run/qemu-server/102.qmp"


def main():
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(10)
    s.connect(QMP)
    buf = b""

    def read():
        nonlocal buf
        while True:
            if b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.strip():
                    return json.loads(line.decode())
            buf += s.recv(4096)

    def cmd(execute, arguments=None):
        msg = {"execute": execute}
        if arguments is not None:
            msg["arguments"] = arguments
        s.sendall((json.dumps(msg) + "\n").encode())
        while True:
            o = read()
            if "return" in o or "error" in o:
                print(execute, o)
                return o

    read()
    cmd("qmp_capabilities")

    def send(keys, hold=120):
        cmd(
            "send-key",
            {
                "keys": [{"type": "qcode", "data": k} for k in keys],
                "hold-time": hold,
            },
        )
        time.sleep(0.2)

    send(["alt", "o"], 180)
    time.sleep(0.4)
    send(["ret"], 200)
    time.sleep(0.3)
    # Absolute click on accent-blue OK (sampled at 300,650).
    ax = int(300 * 32767 / 1279)
    ay = int(650 * 32767 / 799)
    cmd(
        "input-send-event",
        {
            "device": "tablet",
            "events": [
                {"type": "abs", "data": {"axis": "x", "value": ax}},
                {"type": "abs", "data": {"axis": "y", "value": ay}},
            ],
        },
    )
    time.sleep(0.05)
    cmd(
        "input-send-event",
        {
            "device": "tablet",
            "events": [
                {"type": "btn", "data": {"down": True, "button": "left"}},
            ],
        },
    )
    time.sleep(0.08)
    cmd(
        "input-send-event",
        {
            "device": "tablet",
            "events": [
                {"type": "btn", "data": {"down": False, "button": "left"}},
            ],
        },
    )
    time.sleep(1.0)
    cmd("screendump", {"filename": "/tmp/vm102-ok.ppm"})
    s.close()


if __name__ == "__main__":
    main()
