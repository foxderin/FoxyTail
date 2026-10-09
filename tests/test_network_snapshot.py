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

    def test_system_default_changes_with_both_links_retained(self):
        links = network(100, 'CELLULAR', 'rmnet_data0') + network(101, 'WIFI', 'wlan0')
        first_rc, first = self.snapshot('Active default network: 101\nCurrent Networks:\n' + links)
        second_rc, second = self.snapshot('Active default network: 100\nCurrent Networks:\n' + links)
        self.assertEqual((first_rc, second_rc), (0, 0))
        self.assertEqual((first['netId'], first['transport'], first['interface']), ('101', 'wifi', 'wlan0'))
        self.assertEqual((second['netId'], second['transport'], second['interface']), ('100', 'cellular', 'rmnet_data0'))
        self.assertNotEqual(first['signature'], second['signature'])

    def test_dns_order_ipv6_and_changes_remain_visible(self):
        _, old = self.snapshot('Active default network: 101\n' + network(101, 'WIFI', 'wlan0', ' /fec0::3,/10.0.2.3 '))
        _, new = self.snapshot('Active default network: 101\n' + network(101, 'WIFI', 'wlan0', ' /10.0.2.4 '))
        self.assertEqual(old['dns'], ['fec0::3', '10.0.2.3'])
        self.assertEqual(new['dns'], ['10.0.2.4'])
        self.assertNotEqual(old['signature'], new['signature'])

    def test_ethernet_and_vpn_are_not_cellular(self):
        for transport, iface, expected in [('ETHERNET', 'eth0', 'ethernet'), ('VPN WIFI', 'tun0', 'vpn')]:
            with self.subTest(transport=transport):
                rc, result = self.snapshot('Active default network: 7\n' + network(7, transport, iface))
                self.assertEqual(rc, 0)
                self.assertEqual(result['transport'], expected)

    def test_old_android_record_keeps_active_id_authority(self):
        dump = ('Active default network: 102\n'
                'NetworkAgentInfo [WIFI () - 101] CONNECTED\n'
                '  LinkProperties: {InterfaceName: wlan0 DnsAddresses: [ /192.168.1.1 ]}\n'
                '  NetworkCapabilities: [ Transports: WIFI Capabilities: INTERNET ]\n'
                'NetworkAgentInfo [MOBILE (LTE) - 102] CONNECTED\n'
                '  LinkProperties: {InterfaceName: rmnet0 DnsAddresses: [ /10.1.0.1 ]}\n'
                '  NetworkCapabilities: [ Transports: CELLULAR Capabilities: INTERNET ]\n')
        rc, result = self.snapshot(dump)
        self.assertEqual(rc, 0)
        self.assertEqual((result['netId'], result['interface'], result['dns']), ('102', 'rmnet0', ['10.1.0.1']))

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
