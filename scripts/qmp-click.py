#!/usr/bin/env python3
"""Click an absolute screen point in VM 102 via QMP usb-tablet events."""
import json
import socket
import sys
import time

QMP = "/var/run/qemu-server/102.qmp"
W, H = 1280, 800


class Qmp:
    def __init__(self):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.settimeout(10)
        self.s.connect(QMP)
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

    def cmd(self, execute, arguments=None):
        msg = {"execute": execute}
        if arguments is not None:
            msg["arguments"] = arguments
        self.s.sendall((json.dumps(msg) + "\n").encode())
        while True:
            obj = self.read_obj()
            if "error" in obj or "return" in obj:
                if "error" in obj:
                    print("ERR", execute, obj)
                return obj


def abs_val(px, size):
    return int(px * 32767 / max(size - 1, 1))


def click(q: Qmp, x: int, y: int):
    ax, ay = abs_val(x, W), abs_val(y, H)
    print(f"click {x},{y} -> abs {ax},{ay}")
    q.cmd(
        "input-send-event",
        {
            "events": [
                {"type": "abs", "data": {"axis": "x", "value": ax}},
                {"type": "abs", "data": {"axis": "y", "value": ay}},
            ]
        },
    )
    time.sleep(0.05)
    q.cmd(
        "input-send-event",
        {
            "events": [
                {"type": "abs", "data": {"axis": "x", "value": ax}},
                {"type": "abs", "data": {"axis": "y", "value": ay}},
                {"type": "btn", "data": {"down": True, "button": "left"}},
            ]
        },
    )
    time.sleep(0.06)
    q.cmd(
        "input-send-event",
        {
            "events": [
                {"type": "btn", "data": {"down": False, "button": "left"}},
            ]
        },
    )


def find_ok_button(path: str):
    from PIL import Image

    im = Image.open(path).convert("RGB")
    px = im.load()
    w, h = im.size
    # Windows 11 accent OK is a mid-blue rounded rect in the lower-left Run dialog.
    hits = []
    for y in range(int(h * 0.45), h - 20):
        for x in range(20, int(w * 0.55)):
            r, g, b = px[x, y]
            if 20 < r < 90 and 90 < g < 170 and 180 < b < 255 and b > r + 80:
                hits.append((x, y))
    if not hits:
        return None
    xs = [p[0] for p in hits]
    ys = [p[1] for p in hits]
    return (sum(xs) // len(xs), sum(ys) // len(ys), len(hits))


def main():
    if sys.argv[1] == "find":
        print(find_ok_button(sys.argv[2]))
        return
    x, y = int(sys.argv[1]), int(sys.argv[2])
    q = Qmp()
    click(q, x, y)
    q.s.close()
    print("clicked")


if __name__ == "__main__":
    main()
