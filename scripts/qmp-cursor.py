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
    ax = int(238 * 32767 / 1279)
    ay = int(635 * 32767 / 799)
    print("abs", ax, ay)
    cmd(
        "input-send-event",
        {
            "events": [
                {"type": "abs", "data": {"axis": "x", "value": ax}},
                {"type": "abs", "data": {"axis": "y", "value": ay}},
            ]
        },
    )
    time.sleep(0.4)
    cmd("screendump", {"filename": "/tmp/vm102-cursor.ppm"})
    s.close()


if __name__ == "__main__":
    main()
