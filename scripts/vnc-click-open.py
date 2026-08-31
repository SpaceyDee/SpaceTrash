"""Click Edge's Open on the Win11 VM via tunneled VNC. Ticket is never printed."""
import json
import os
import select
import socket
import sys
import threading
import time

import paramiko
from PIL import Image
from vncdotool import api

HOST = "192.168.0.249"
LOCAL_PORT = 15901
HERE = os.path.dirname(os.path.abspath(__file__))


def ssh():
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


def vncproxy(c):
    stdin, stdout, stderr = c.exec_command(
        "pvesh create /nodes/pve01/qemu/102/vncproxy --output-format json",
        timeout=30,
    )
    raw = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    if stdout.channel.recv_exit_status() != 0:
        raise SystemExit(f"vncproxy failed: {err[:200]}")
    info = json.loads(raw)
    return int(info["port"]), info.get("password") or info["ticket"]


def pump(local, chan):
    try:
        while True:
            r, _, _ = select.select([local, chan], [], [], 60)
            if local in r:
                data = local.recv(8192)
                if not data:
                    break
                chan.sendall(data)
            if chan in r:
                if chan.recv_ready():
                    data = chan.recv(8192)
                    if not data:
                        break
                    local.sendall(data)
                elif chan.eof_received:
                    break
    except Exception:
        pass
    try:
        local.close()
    except Exception:
        pass
    try:
        chan.close()
    except Exception:
        pass


def start_tunnel(transport, remote_port):
    lsock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    lsock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    lsock.bind(("127.0.0.1", LOCAL_PORT))
    lsock.listen(2)
    lsock.settimeout(20)

    def accept_loop():
        while True:
            try:
                client, _ = lsock.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            try:
                chan = transport.open_channel(
                    "direct-tcpip",
                    ("127.0.0.1", remote_port),
                    ("127.0.0.1", LOCAL_PORT),
                )
            except Exception:
                client.close()
                continue
            threading.Thread(target=pump, args=(client, chan), daemon=True).start()

    threading.Thread(target=accept_loop, daemon=True).start()
    return lsock


def find_open_button(path: str):
    im = Image.open(path).convert("RGB")
    px = im.load()
    w, h = im.size
    hits = []
    # Edge download flyout sits in the top-right; Open is the left accent button.
    for y in range(40, min(280, h)):
        for x in range(int(w * 0.55), w - 8):
            r, g, b = px[x, y]
            if 0 <= r < 80 and 80 < g < 180 and 180 < b < 255 and b > r + 90:
                hits.append((x, y))
    if not hits:
        return None
    xs = [p[0] for p in hits]
    ys = [p[1] for p in hits]
    # Leftmost cluster = Open (Save as / Save are to the right).
    min_x = min(xs)
    cluster = [p for p in hits if p[0] < min_x + 90]
    cx = sum(p[0] for p in cluster) // len(cluster)
    cy = sum(p[1] for p in cluster) // len(cluster)
    return cx, cy, len(cluster)


def connect_vnc():
    c = ssh()
    remote_port, password = vncproxy(c)
    print("vncproxy port", remote_port)
    tunnel = start_tunnel(c.get_transport(), remote_port)
    time.sleep(0.25)
    client = api.connect(f"127.0.0.1::{LOCAL_PORT}", password=password)
    client.timeout = 25
    print("vnc connected")
    return c, tunnel, client


def main():
    c, tunnel, client = connect_vnc()
    before = os.path.join(HERE, "vm102-vnc-before.png")
    client.captureScreen(before)
    print("captured before")
    found = find_open_button(before)
    if found:
        x, y, n = found
        print("open button", x, y, "pixels", n)
    else:
        x, y = 1100, 170
        print("open button fallback", x, y)
    client.mouseMove(x, y)
    time.sleep(0.15)
    client.mousePress(1)
    time.sleep(0.4)
    after = os.path.join(HERE, "vm102-vnc-clicked.png")
    client.captureScreen(after)
    print("captured after click")
    try:
        client.disconnect()
    except Exception as e:
        print("disconnect", type(e).__name__)
    try:
        tunnel.close()
    except Exception:
        pass
    try:
        c.close()
    except Exception:
        pass
    print("done")
    sys.exit(0)


if __name__ == "__main__":
    main()
