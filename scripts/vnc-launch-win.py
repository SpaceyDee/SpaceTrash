"""SSH-tunnel to Proxmox VNC and launch SpaceTrash. Ticket is never printed."""
import json
import os
import select
import socket
import threading
import time

import paramiko
from vncdotool import api

HOST = "192.168.0.249"
LOCAL_PORT = 15901


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

    t = threading.Thread(target=accept_loop, daemon=True)
    t.start()
    return lsock


def main():
    c = ssh()
    remote_port, password = vncproxy(c)
    print("vncproxy port", remote_port)
    tunnel = start_tunnel(c.get_transport(), remote_port)
    time.sleep(0.2)
    client = api.connect(f"127.0.0.1::{LOCAL_PORT}", password=password)
    client.timeout = 20
    print("vnc connected")
    client.keyPress("esc")
    time.sleep(0.25)
    client.keyDown("super")
    client.keyPress("r")
    client.keyUp("super")
    time.sleep(0.9)
    for ch in r"D:\RUN-ME.bat":
        if ch == "\\":
            client.keyPress("bslash")
        elif ch == ":":
            client.keyDown("shift")
            client.keyPress(";")
            client.keyUp("shift")
        elif ch.isupper():
            client.keyDown("shift")
            client.keyPress(ch.lower())
            client.keyUp("shift")
        else:
            client.keyPress(ch)
        time.sleep(0.04)
    time.sleep(0.3)
    client.mouseMove(300, 650)
    time.sleep(0.12)
    client.mousePress(1)
    time.sleep(0.15)
    client.keyPress("enter")
    time.sleep(1.0)
    client.captureScreen(r"G:\Projects\SpaceTrash\scripts\vm102-vnc-after.png")
    client.disconnect()
    print("sent")
    tunnel.close()
    c.close()


if __name__ == "__main__":
    main()
