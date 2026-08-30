"""On the Proxmox host: VNC-click OK / launch SpaceTrash. Never prints the ticket."""
import json
import subprocess
import sys
import time


def vncproxy():
    raw = subprocess.check_output(
        ["pvesh", "create", "/nodes/pve01/qemu/102/vncproxy", "--output-format", "json"],
        text=True,
    )
    return json.loads(raw)


def have_vncdotool():
    try:
        import vncdotool  # noqa: F401
        return True
    except ImportError:
        return False


def install_vncdotool():
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "vncdotool"])


def launch():
    info = vncproxy()
    port = int(info["port"])
    password = info.get("password") or info.get("ticket")
    if not have_vncdotool():
        try:
            install_vncdotool()
        except Exception as e:
            print("pip failed", type(e).__name__)
            raise
    from vncdotool import api

    client = api.connect(f"127.0.0.1::{port}", password=password)
    client.timeout = 15
    print("vnc connected")
    # Dismiss anything, open Run, type RUN-ME, press OK via click on typical Run OK.
    client.keyPress("esc")
    time.sleep(0.2)
    client.keyDown("cmd")
    client.keyPress("r")
    client.keyUp("cmd")
    time.sleep(0.8)
    client.enter("D:\\RUN-ME.bat")
    time.sleep(0.3)
    # Click OK: sampled blue button ~300,650 on 1280x800
    client.mouseMove(300, 650)
    time.sleep(0.15)
    client.mouseDown(1)
    time.sleep(0.05)
    client.mouseUp(1)
    time.sleep(0.2)
    client.keyPress("enter")
    client.disconnect()
    print("vnc launch sent")


if __name__ == "__main__":
    launch()
