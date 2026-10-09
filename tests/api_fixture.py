"""Private filesystem and actual shell modules shared by the WebAPI tests."""
import io
import os
import shutil
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import tempfile
import unittest

from runtime_fixture import ROOT, host_process_shell, install_settings


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-api-test-')
        self.base = Path(self.temp.name).resolve()
        self.conf = self.base / 'conf'
        self.run = self.base / 'run'
        self.scripts = self.base / 'scripts'
        self.sdcard = self.base / 'sdcard'
        for directory in [self.conf, self.run, self.scripts, self.sdcard / 'Download']:
            directory.mkdir(parents=True, exist_ok=True)
        for name in ['foxytail.conf', 'routes.conf', 'context.conf']:
            (self.conf / name).write_bytes((ROOT / 'tailscale/conf' / name).read_bytes())
        install_settings(self.base)
        taildrop = self.scripts / 'foxytail.taildrop.sh'
        taildrop.write_text(taildrop.read_text().replace('/sdcard', str(self.sdcard)))
        binary = os.environ.get('FOXYFILES_TEST_BINARY')
        if binary:
            (self.base / 'bin').mkdir(exist_ok=True)
            shutil.copyfile(binary, self.base / 'bin/foxyfiles')
            (self.base / 'bin/foxyfiles').chmod(0o755)
        context = (ROOT / 'tailscale/scripts/foxytail.context').read_text()
        # Keep the actual validator; watcher lifecycle is outside this fixture.
        context = context.replace('#!/system/bin/sh', '#!/bin/sh\n'
            'case "$1" in start|stop) exit 0 ;; esac', 1)
        (self.scripts / 'foxytail.context').write_text(context)
        (self.scripts / 'foxytail.context').chmod(0o755)
        (self.scripts / 'start.sh').write_text('#!/bin/sh\n[ "$1" = reload-residents ]\n')
        (self.scripts / 'start.sh').chmod(0o755)
        for path in (ROOT / 'tailscale/scripts').glob('foxytail.webapi*.sh'):
            source = path.read_text().replace('/sdcard', str(self.sdcard))
            source = source.replace('"${TS_SCRIPTS_DIR}/start.sh" reload-residents',
                                    'sh "${TS_SCRIPTS_DIR}/start.sh" reload-residents')
            (self.scripts / path.name).write_text(source)
        source = (self.scripts / 'foxytail.webapi.sh').read_text()
        helpers = source[source.index('# --- Helpers'):source.index('# --- dispatch')]
        self.lib = self.base / 'helpers.sh'
        platform = ''
        if sys.platform == 'darwin':
            # Preserve Android byte/size semantics using real host readers.
            encoder = shlex.quote(sys.executable) + " -c 'import base64,sys; sys.stdout.buffer.write(base64.b64encode(sys.stdin.buffer.read()))'"
            platform = '''stat() {
  case "$1:$2" in
    -c:%s) shift 2; /usr/bin/stat -f %z "$@" ;;
    -c:%Y) shift 2; /usr/bin/stat -f %m "$@" ;;
    *) /usr/bin/stat "$@" ;;
  esac
}
base64() {
  case "$1" in -w0) ''' + encoder + ''' ;; *) /usr/bin/base64 "$@" ;; esac
}
tar() {
  case "$1" in -czf) command tar --format ustar "$@" ;; *) command tar "$@" ;; esac
}
'''
        self.lib.write_text(
            'DIR=' + shlex.quote(str(self.scripts)) + '\n' +
            '. ' + shlex.quote(str(self.base / 'settings.sh')) + '\n' +
            'mkdir -p "$TS_PID_DIR"\n' + platform + helpers + host_process_shell() + '\n'
        )

    def tearDown(self):
        self.temp.cleanup()

    def shell(self, script, ok=True):
        result = subprocess.run(['sh', '-c', '. "$1"\n' + script, 'test', str(self.lib)], text=True, capture_output=True, timeout=20)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result

    def archive(self, entries):
        path = self.sdcard / 'fixture.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, body in entries.items():
                info = tarfile.TarInfo(name)
                if isinstance(body, tuple):
                    info.type = tarfile.SYMTYPE
                    info.linkname = body[0]
                    archive.addfile(info)
                else:
                    content = body.encode()
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
        return path

    def snapshot(self):
        return {file.name: file.read_bytes() for file in self.conf.iterdir()}
