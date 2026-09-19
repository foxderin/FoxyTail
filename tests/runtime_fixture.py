"""Relocate the real runtime and its sourced libraries into a private directory."""
from pathlib import Path
import shlex
import shutil

ROOT = Path(__file__).resolve().parents[1]


def install_settings(base):
    settings = base / 'settings.sh'
    settings.write_text((ROOT / 'tailscale/settings.sh').read_text().replace(
        'TS_DIR="/data/adb/foxytail"', 'TS_DIR=' + shlex.quote(str(base))))
    for name in ('foxytail.config.sh', 'foxytail.lock.sh'):
        shutil.copyfile(ROOT / 'tailscale/scripts' / name, base / 'scripts' / name)
    return settings
