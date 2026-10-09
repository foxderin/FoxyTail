import type { ApiResult } from './api';
import { normalizeCidr } from './cidr';
import type { DnsInfo } from './pages/tunnel-dns';

export type FilterMode = 'blacklist' | 'rule' | 'redir-host';
export interface CoexistPeer {
  id: string;
  hostname: string;
  dnsName: string;
  ips: string[];
  online: boolean;
}
export interface CoexistInfo extends ApiResult {
  snapshot: string;
  mode: 'bridge' | 'proxy' | 'tun';
  socksPort: number;
  ipv6Enabled: boolean;
  suffix: string;
  dns: DnsInfo;
  dnsReady: boolean;
  peers: CoexistPeer[];
  addresses: string[];
  environment: {
    modules: { name: string; kind: string }[];
    apps: { package: string; kind: string }[];
    warnings: string[];
    alert: string | null;
  };
}
export type CheckId = 'dns-udp' | 'dns-tcp' | 'resolver-udp' | 'resolver-tcp' | 'tcp';
export interface CoexistCheck extends ApiResult {
  snapshot: string;
  name: string;
  address: string;
  targetPort: number;
  path: 'socks5' | 'system';
  checks: { id: CheckId; ok: boolean; error?: string; addresses?: string[]; elapsedMs: number }[];
}

const validPort = (port: unknown): port is number =>
  typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;

/** A merge fragment, never a replacement configuration or a global DNS upstream. */
export function coexistSnippet(info: CoexistInfo, filterMode: FilterMode): string {
  if (!['blacklist', 'rule', 'redir-host'].includes(filterMode)) throw new Error('Unsupported fake-IP filter mode');
  if (!info.ok || info.dnsReady !== true || !info.dns?.ok ||
      !['local', 'transparent'].includes(info.dns.mode || '') || info.dns.enabled !== true ||
      info.dns.listenerReady !== true || info.dns.repairNeeded !== false || info.dns.policyState !== 'owned' ||
      info.dns.suffix !== info.suffix) throw new Error('Current FoxyTail DNS listener is not ready');
  if (!['bridge', 'proxy', 'tun'].includes(info.mode)) throw new Error('Invalid applied tunnel mode');
  if (!validPort(info.dns.port) || !validPort(info.socksPort)) throw new Error('Invalid applied port');
  const suffix = info.suffix;
  if (typeof suffix !== 'string' || suffix.length > 253 || suffix.toLowerCase() === 'ts.net' ||
      suffix.split('.').length < 2 || suffix.split('.').some(label =>
        !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) {
    throw new Error('Invalid current Tailnet DNS suffix');
  }
  if (!Array.isArray(info.addresses) || !info.addresses.length) throw new Error('No current node addresses');
  const cidrs = new Set<string>();
  for (const address of info.addresses) {
    if (typeof address !== 'string' || !/^[\da-fA-F:.]+$/.test(address)) throw new Error('Invalid current node address');
    const cidr = normalizeCidr(address + (address.includes(':') ? '/128' : '/32'));
    if (!cidr) throw new Error('Invalid current node address');
    const ip = cidr.split('/')[0]!;
    if (ip.includes(':') ? ip === '::' || ip === '::1' || /^ff|^fe[89ab]|^::ffff:/i.test(ip)
      : /^(0|127)\./.test(ip) || /^169\.254\./.test(ip) || Number(ip.split('.')[0]) >= 224) {
      throw new Error('Current node address must be unicast');
    }
    cidrs.add(cidr);
  }
  const quote = JSON.stringify;
  const proxy = 'FoxyTail-Tailnet';
  const lines = [
    'dns:',
    '  enable: true',
    '  nameserver-policy:',
    `    ${quote('+.' + suffix)}: ${quote('tcp://127.0.0.1:' + info.dns.port + '#DIRECT')}`,
    '  direct-nameserver-follow-policy: true',
  ];
  if (filterMode !== 'redir-host') lines.push(
    `  fake-ip-filter-mode: ${filterMode}`,
    '  fake-ip-filter:',
    `    - ${quote(filterMode === 'blacklist' ? '+.' + suffix : 'DOMAIN-SUFFIX,' + suffix + ',real-ip')}`,
  );
  lines.push('proxies:', `  - name: ${quote(proxy)}`);
  if (info.mode === 'tun') lines.push('    type: direct', '    interface-name: "tailscale0"');
  else lines.push('    type: socks5', '    server: "127.0.0.1"', `    port: ${info.socksPort}`);
  lines.push('    udp: true', 'rules:', `  - ${quote('DOMAIN-SUFFIX,' + suffix + ',' + proxy)}`);
  for (const cidr of cidrs) lines.push(`  - ${quote((cidr.includes(':') ? 'IP-CIDR6,' : 'IP-CIDR,') + cidr + ',' + proxy + ',no-resolve')}`);
  return lines.join('\n') + '\n';
}
