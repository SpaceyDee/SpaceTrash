"""Publish SpaceTrash Windows updater files to LXC 100 (nginx).

Requires PVE_PASS. Uploads latest.yml, the NSIS setup exe, and its blockmap
so the app can pull from http://192.168.0.100/spacetrash/
"""
from __future__ import annotations

import base64
import importlib.util
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DIST = REPO / "dist" / "desktop"
CT = 100
REMOTE_DIR = "/var/www/spacetrash-updates"
FEED = "http://192.168.0.100/spacetrash"

_spec = importlib.util.spec_from_file_location("pve_ssh", HERE / "pve-ssh.py")
_pve = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_pve)
connect = _pve.connect
run = _pve.run

NGINX_SNIPPET = """\
location /spacetrash/ {
    alias /var/www/spacetrash-updates/;
    autoindex off;
    default_type application/octet-stream;
    types {
        text/yaml yml yaml;
        application/octet-stream exe blockmap;
    }
    add_header Cache-Control "no-store";
    add_header X-Content-Type-Options nosniff;
}
"""


def exec_ct(c, cmd: str, timeout: int = 120) -> tuple[int, str, str]:
    quoted = cmd.replace("'", "'\"'\"'")
    return run(c, f"pct exec {CT} -- bash -lc '{quoted}'", timeout=timeout)


def setup_nginx(c) -> None:
    code, out, err = run(c, f"pct status {CT}")
    if code != 0 or "running" not in out:
        raise SystemExit(f"LXC {CT} is not running:\n{out}{err}")

    code, which, err = exec_ct(c, "command -v nginx && nginx -v")
    if code != 0:
        raise SystemExit(f"nginx not installed in LXC {CT}:\n{which}{err}")

    exec_ct(c, f"mkdir -p {REMOTE_DIR} /etc/nginx/snippets")
    snippet = "/etc/nginx/snippets/spacetrash-updates.conf"
    b64 = base64.b64encode(NGINX_SNIPPET.encode()).decode()
    code, out, err = exec_ct(c, f"echo {b64} | base64 -d > {snippet}")
    if code != 0:
        raise SystemExit(f"failed to write nginx snippet:\n{out}{err}")

    py = (
        "from pathlib import Path\n"
        "p = Path('/etc/nginx/sites-enabled/default').resolve()\n"
        "t = p.read_text()\n"
        "inc = '    include /etc/nginx/snippets/spacetrash-updates.conf;\\n'\n"
        "if 'spacetrash-updates.conf' in t:\n"
        "    raise SystemExit(0)\n"
        "i = t.find('server {')\n"
        "if i < 0:\n"
        "    raise SystemExit('no server block')\n"
        "j = t.find(chr(10), i) + 1\n"
        "p.write_text(t[:j] + inc + t[j:])\n"
    )
    py_b64 = base64.b64encode(py.encode()).decode()
    code, out, err = exec_ct(c, f"echo {py_b64} | base64 -d | python3")
    if code != 0:
        raise SystemExit(f"failed to patch nginx site:\n{out}{err}")

    code, out, err = exec_ct(c, "nginx -t && systemctl reload nginx")
    if code != 0:
        raise SystemExit(f"nginx reload failed:\n{out}{err}")
    print(f"nginx serving {FEED}")


def artifacts() -> list[Path]:
    yml = DIST / "latest.yml"
    if not yml.is_file():
        raise SystemExit(f"missing {yml} — run npm run dist:win first")
    setup = sorted(DIST.glob("SpaceTrash-Setup-*.exe"))
    if not setup:
        raise SystemExit(f"no SpaceTrash-Setup-*.exe in {DIST}")
    exe = setup[-1]
    files = [yml, exe]
    blockmap = DIST / f"{exe.name}.blockmap"
    if blockmap.is_file():
        files.append(blockmap)
    return files


def publish(c, files: list[Path]) -> None:
    exec_ct(c, f"mkdir -p {REMOTE_DIR}")
    sftp = c.open_sftp()
    try:
        for path in files:
            tmp = f"/root/{path.name}"
            print(f"upload {path.name} ({path.stat().st_size} bytes)")
            sftp.put(str(path), tmp)
            dest = f"{REMOTE_DIR}/{path.name}"
            code, out, err = run(c, f"pct push {CT} {tmp} {dest}", timeout=300)
            if code != 0:
                raise SystemExit(f"pct push failed for {path.name}:\n{out}{err}")
            exec_ct(c, f"chmod 644 '{dest}'")
            run(c, f"rm -f {tmp}")
    finally:
        sftp.close()


def main() -> int:
    if "PVE_PASS" not in os.environ:
        raise SystemExit("set PVE_PASS")
    c = connect()
    try:
        if "--setup" in sys.argv:
            print(f"configuring nginx on LXC {CT}")
            setup_nginx(c)
        if not (DIST / "latest.yml").is_file():
            if "--setup" in sys.argv:
                print("setup done; run again after npm run dist:win to publish")
                return 0
            raise SystemExit(f"missing {DIST / 'latest.yml'} — run npm run dist:win first")
        files = artifacts()
        publish(c, files)
        print(f"feed {FEED}/latest.yml")
        for path in files:
            print(f"  {FEED}/{path.name}")
    finally:
        c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
