/* Shared API payload shapes. */

export interface Peer {
  id: string;
  hostname: string;
  ip: string;
  ips?: string[]; // Full address list; older backends only return ip.
  os: string;
  relay: string;
  online: boolean;
  curAddr?: string; // Established direct path; older backends omit it.
  active?: boolean; // Recent direct activity; older backends omit it.
  rxBytes: number;
  txBytes: number;
  exitNodeOption: boolean;
}

export interface ExitNodeProbe {
  id: string;
  hostname: string;
  ip: string;
  latencyMs: number | null;
  ok: boolean;
}

export interface ExitRouting {
  known: boolean;
  selected: { id: string; ip: string; auto: string; allowLAN: boolean } | null;
  profile?: string;
  scope?: string;
  uids?: string[];
  effective: 'unknown' | 'none' | 'explicit-proxy' | 'daemon-owned' | 'bridge-policy' | 'not-effective';
  ipv4: boolean;
  ipv6: boolean;
  warning: string;
}

export interface AppInfo {
  label: string;
  package: string;
  uid: number;
}

export interface InboxFile {
  name: string;
  size: number;
  mtime: number;
}

export interface TaildropTarget {
  id: string;
  hostname: string;
  ips: string[];
  online: boolean;
}

export interface BrowseEntry extends InboxFile {
  path: string;
  directory: boolean;
}

export type TransferFileStatus = 'queued' | 'sending' | 'completed' | 'failed' | 'cancelled';
export type TransferStatus = TransferFileStatus | 'interrupted';

export interface TransferFile {
  id: string;
  name: string;
  path: string;
  size: number;
  sentBytes: number;
  progressKnown: boolean;
  bytesPerSecond: number;
  status: TransferFileStatus;
  error?: string;
}

export interface Transfer {
  id: string;
  peerId: string;
  peerName: string;
  peerIp: string;
  selfId: string;
  status: TransferStatus;
  startedAt: number;
  updatedAt: number;
  files: TransferFile[];
  error?: string;
}

export interface AccountEntry {
  name: string;
  label?: string;
  current: boolean;
}

export interface DerpRelay {
  code: string;
  latencyMs: number;
}

export interface RoutesInfo {
  scope: string;
  uids: string[];
  subnets: string[];
}

export interface SubnetRoutesInfo {
  acceptRoutes: boolean | null;
  mode: string;
  ipv6Enabled?: boolean;
  peers: Array<{
    id: string;
    hostname: string;
    online: boolean;
    routes: Array<{ cidr: string; primary: boolean }>;
  }>;
}
