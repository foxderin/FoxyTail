"""Exercise the actual bundled SOCKS probe through direct and durable JSON APIs."""
import os
import shutil
import socket
import threading
import time

from api_fixture import ApiTestCase
import test_api_entrypoints as entrypoints


class SocksCheckTests(ApiTestCase):
    script = entrypoints.ApiEntrypointTests.script
    entry_fixture = entrypoints.ApiEntrypointTests.entry_fixture
    entry = entrypoints.ApiEntrypointTests.entry

    def setUp(self):
        super().setUp()
        self.entry_fixture()
        binary = os.environ.get('FOXYDNS_TEST_BINARY')
        if not binary:
            self.fail('FOXYDNS_TEST_BINARY is required; run .github/tools/verify.sh')
        target = self.base / 'bin/foxydns'
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(binary, target)
        target.chmod(0o755)
        self.script('bin/curl', 'touch "$TEST_DIR/unexpected-curl"\nexit 99\n')

    def rejecting_proxy(self):
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        listener.settimeout(10)
        result = []

        def serve():
            try:
                with listener.accept()[0] as connection:
                    connection.settimeout(10)
                    greeting = b''
                    while len(greeting) < 3:
                        part = connection.recv(3 - len(greeting))
                        if not part:
                            raise RuntimeError('client ended before SOCKS greeting')
                        greeting += part
                    result.append(greeting)
                    connection.sendall(b'\x05\xff')
            except Exception as error:
                result.append(error)
            finally:
                listener.close()

        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        self.addCleanup(listener.close)
        self.addCleanup(lambda: worker.join(11))
        return listener.getsockname()[1], worker, result

    def test_uses_applied_port_and_preserves_real_proxy_failure_without_curl(self):
        port, worker, result = self.rejecting_proxy()
        self.shell(f'conf_write_key foxytail.conf SOCKS_PORT {port}; conf_activate_runtime')
        self.shell(f'conf_write_key foxytail.conf SOCKS_PORT {1200 if port != 1200 else 1201}')
        checked = self.entry('socks-check')
        worker.join(10)
        self.assertEqual(result, [b'\x05\x01\x00'])
        self.assertFalse(checked['success'])
        self.assertEqual(checked['httpCode'], '')
        self.assertGreaterEqual(checked['elapsedMs'], 0)
        self.assertFalse((self.base / 'unexpected-curl').exists())


    def test_probe_rejects_missing_helper_native_tun_and_arbitrary_targets(self):
        self.shell('conf_activate_runtime')
        self.entry('socks-check', 'https://untrusted.example', ok=False)
        (self.base / 'bin/foxydns').unlink()
        self.entry('socks-check', ok=False)
        self.shell('conf_write_key foxytail.conf TS_MODE tun; conf_activate_runtime')
        self.entry('socks-check', ok=False)
        self.assertFalse((self.base / 'unexpected-curl').exists())
