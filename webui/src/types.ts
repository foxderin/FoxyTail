/* Shared API payload shapes (frozen webapi contract). */

export interface Peer {
  id: string;
  hostname: string;
  ip: string;
  ips?: string[]; // Full address list; older backends only return ip.
  os: string;
  relay: string;
  online: boolean;
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
