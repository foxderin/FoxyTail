/** Canonical network prefixes for drafts and discovered subnet routes. */
export function normalizeCidr(input: string): string | null {
  const parts = input.trim().split('/');
  if (parts.length !== 2 || !/^\d{1,3}$/.test(parts[1]!)) return null;
  const prefix = Number(parts[1]);
  let address = parts[0]!;
  if (!address.includes(':')) {
    const octets = address.split('.');
    if (prefix > 32 || octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null;
    const value = octets.reduce((total, octet) => total * 256n + BigInt(Number(octet)), 0n);
    const network = (value >> BigInt(32 - prefix)) << BigInt(32 - prefix);
    return [24n, 16n, 8n, 0n].map(shift => Number((network >> shift) & 255n)).join('.') + '/' + prefix;
  }
  if (address.includes('.')) {
    const colon = address.lastIndexOf(':');
    const octets = address.slice(colon + 1).split('.');
    if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null;
    address = address.slice(0, colon + 1) + ((Number(octets[0]) << 8) + Number(octets[1])).toString(16) + ':' + ((Number(octets[2]) << 8) + Number(octets[3])).toString(16);
  }
  if (prefix > 128 || !/^[\da-fA-F:]+$/.test(address) || address.includes(':::')) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some(group => !/^[\da-fA-F]{1,4}$/.test(group))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? left.length !== 8 : missing < 1) return null;
  const groups = halves.length === 1 ? left : [...left, ...Array<string>(missing).fill('0'), ...right];
  const value = BigInt('0x' + groups.map(group => group.padStart(4, '0')).join(''));
  const network = (value >> BigInt(128 - prefix)) << BigInt(128 - prefix);
  const words = Array.from({ length: 8 }, (_, index) => Number((network >> BigInt((7 - index) * 16)) & 65535n));
  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) { index++; continue; }
    const start = index;
    while (index < words.length && words[index] === 0) index++;
    if (index - start > bestLength) { bestStart = start; bestLength = index - start; }
  }
  const hex = words.map(word => word.toString(16));
  const canonical = bestStart < 0 ? hex.join(':') : hex.slice(0, bestStart).join(':') + '::' + hex.slice(bestStart + bestLength).join(':');
  return canonical + '/' + prefix;
}
