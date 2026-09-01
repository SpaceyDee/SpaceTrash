"""VNC: click Open, then Space/Enter. Uses os._exit to skip hung disconnect."""
import json
import os
import select
import socket
import threading
import time

import paramiko
from vncdotool import api

HOST = "192.168.0.249"
LOCAL_PORT = 15903


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


def run(c, cmd, timeout=20):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    stdout.read()
    stderr.read()
    return stdout.channel.recv_exit_status()


def pump(local, chan):
    try:
        while True:
            r, _, _ = select.select([local, chan], [], [], 30)
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
    for s in (local, chan):
        try:
            s.close()
        except Exception:
            pass


def main():
    c = ssh()
    run(c, "pkill -f 'vncproxy:102' || true")
    time.sleep(0.5)
    stdin, stdout, stderr = c.exec_command(
        "pvesh create /nodes/pve01/qemu/102/vncproxy --output-format json",
        timeout=25,
    )
    info = json.loads(stdout.read().decode("utf-8", "replace"))
    remote_port = int(info["port"])
    password = info.get("password") or info["ticket"]
    print("vncproxy", remote_port, flush=True)

    lsock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    lsock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    lsock.bind(("127.0.0.1", LOCAL_PORT))
    lsock.listen(2)
    lsock.settimeout(15)
    transport = c.get_transport()

    def accept_loop():
        while True:
            try:
                client, _ = lsock.accept()
            except Exception:
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
    time.sleep(0.25)
    client = api.connect(f"127.0.0.1::{LOCAL_PORT}", password=password)
    client.timeout = 12
    print("connected", flush=True)

    for x, y in ((840, 175), (857, 173), (830, 180)):
        client.mouseMove(x, y)
        time.sleep(0.12)
        client.mouseDown(1)
        time.sleep(0.1)
        client.mouseUp(1)
        time.sleep(0.15)

    client.keyPress("space")
    time.sleep(0.2)
    client.keyPress("enter")
    time.sleep(0.2)
    client.keyPress("return")
    print("keys sent", flush=True)
    os._exit(0)


if __name__ == "__main__":
    main()
