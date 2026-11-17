"""Relocate the real runtime and its sourced libraries into a private directory."""
from pathlib import Path
import shlex
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]

def host_process_shell():
    if sys.platform != 'darwin':
        return ''
    helper = shlex.quote(sys.executable) + ' ' + shlex.quote(str(ROOT / 'tests/host_process.py'))
    return '''
_proc_starttime() { ''' + helper + ''' stamp "$1"; }
_proc_cmdline() { ''' + helper + ''' cmdline "$1"; }
_op_children() { ''' + helper + ''' children "$1"; }
boot_identity() { /usr/sbin/sysctl -n kern.bootsessionuuid; }
monotonic_seconds() { ''' + helper + ''' monotonic; }
_lock_identity() {
  _li_pid=$(''' + helper + ''' self; :)
  _LOCK_TOKEN="${_li_pid}:$(_proc_starttime "${_li_pid}"):$(boot_identity)"
}
'''


def install_settings(base):
    settings = base / 'settings.sh'
    settings.write_text((ROOT / 'tailscale/settings.sh').read_text().replace(
        'TS_DIR="/data/adb/foxytail"', 'TS_DIR=' + shlex.quote(str(base))) + host_process_shell())
    for name in ('foxytail.config.sh', 'foxytail.lock.sh', 'foxytail.network.sh', 'foxytail.taildrop.sh',
                 'foxytail.identity.sh'):
        shutil.copyfile(ROOT / 'tailscale/scripts' / name, base / 'scripts' / name)
    return settings
