"""Android default-network identity must not be inferred from Linux main routes."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def network(netid, transport, iface, dns=' /10.0.2.3 ', extra=''):
    return (f'  NetworkAgentInfo{{network{{{netid}}} ni{{{transport} CONNECTED}} '
            f'lp{{{{InterfaceName: {iface} DnsAddresses: [{dns}] Routes: []}}}} '
            f'nc{{[ Transports: {transport} Capabilities: INTERNET ]}} {extra}}}\n')


class NetworkSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-network-snapshot-')
        self.addCleanup(self.temp.cleanup)
        self.input = Path(self.temp.name) / 'connectivity.txt'

    def snapshot(self, text, exit_code=0):
        script = '. ' + shlex.quote(str(ROOT / 'tailscale/scripts/foxytail.network.sh')) + '''
jqr() { jq "$@"; }
tmo() { cat "$SNAPSHOT_FILE"; return "$DUMP_EXIT"; }
network_snapshot
'''
        self.input.write_text(text)
        result = subprocess.run(['sh', '-c', script], capture_output=True, text=True,
                                env={**os.environ, 'SNAPSHOT_FILE': str(self.input), 'DUMP_EXIT': str(exit_code)}, timeout=10)
        return result.returncode, json.loads(result.stdout)


    def test_ethernet_and_vpn_are_not_cellular(self):
        for transport, iface, expected in [('ETHERNET', 'eth0', 'ethernet'), ('VPN WIFI', 'tun0', 'vpn')]:
            with self.subTest(transport=transport):
                rc, result = self.snapshot('Active default network: 7\n' + network(7, transport, iface))
                self.assertEqual(rc, 0)
                self.assertEqual(result['transport'], expected)


    def test_missing_ambiguous_failed_and_oversized_dumps_are_unknown(self):
        valid = 'Active default network: 101\n' + network(101, 'WIFI', 'wlan0')
        cases = [('', 0), ('Active default network: none\n', 0),
                 ('Active default network: 999\n' + network(101, 'WIFI', 'wlan0'), 0),
                 (valid + network(101, 'CELLULAR', 'rmnet0'), 0),
                 (valid + 'Active default network: 100\n', 0), (valid, 1),
                 ('Active default network: 101\n' + network(101, 'SATELLITE', 'sat0'), 0),
                 (valid + 'x' * 2097152, 0)]
        for index, (dump, exit_code) in enumerate(cases):
            with self.subTest(case=index):
                rc, result = self.snapshot(dump, exit_code)
                self.assertNotEqual(rc, 0)
                self.assertFalse(result['known'])
                self.assertEqual(result['transport'], 'unknown')
                self.assertEqual(result['dns'], [])


if __name__ == '__main__':
    unittest.main()
