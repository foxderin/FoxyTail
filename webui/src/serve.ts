/* Adapter for tailscale ServeConfig. TCP also describes HTTP listeners;
 * listener flags, rather than port numbers, determine the protocol. */
export interface ServeMapping {
  proto: string;
  port: string;
  host: string;
  path?: string;
  target: string;
  funnel: boolean;
  canDelete: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function serveMappings(status: unknown): ServeMapping[] {
  const st = record(status);
  const tcp = record(st.TCP);
  const allowFunnel = record(st.AllowFunnel);
  const out: ServeMapping[] = [];
  for (const [port, handler] of Object.entries(tcp)) {
    const hd = record(handler);
    if (typeof hd.TCPForward !== 'string') continue;
    const funnel = Object.entries(allowFunnel).some(([hp, allow]) => hp.endsWith(':' + port) && allow === true);
    out.push({
      proto: typeof hd.TerminateTLS === 'string' && hd.TerminateTLS ? 'tls-terminated-tcp' : 'tcp',
      port, host: '', target: hd.TCPForward, funnel, canDelete: true,
    });
  }
  for (const [hp, web] of Object.entries(record(st.Web))) {
    const match = /^(.*):(\d+)$/.exec(hp);
    if (!match) continue;
    const [, host, port] = match;
    const listener = record(tcp[port]);
    const proto = listener.HTTPS === true ? 'https' : listener.HTTP === true ? 'http' : 'unknown';
    for (const [path, handler] of Object.entries(record(record(web).Handlers))) {
      const hd = record(handler);
      const target = [hd.Proxy, hd.Path, hd.Text].find((v) => typeof v === 'string');
      out.push({
        proto, port, host, path, target: typeof target === 'string' ? target : '',
        funnel: allowFunnel[hp] === true, canDelete: proto !== 'unknown',
      });
    }
  }
  return out;
}

export function serveDeleteArgs(mapping: ServeMapping): string[] {
  if (!mapping.canDelete) throw new Error('Unsupported Serve listener');
  return mapping.path === undefined
    ? [mapping.proto, mapping.port]
    : [mapping.proto, mapping.port, mapping.path];
}
