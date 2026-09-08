#!/usr/bin/env node
/* i18n key parity check: extract zh/en key sets from src/i18n.ts and diff. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/i18n.ts'), 'utf8');

function blockKeys(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('markers not found: ' + startMarker);
  const block = src.slice(start, end);
  const keys = new Set();
  /* keys may share a line (nav_dashboard: '仪表盘', nav_peers: '节点', ...);
   * a key must follow a line start, comma or opening brace so colons inside
   * translated strings (e.g. "expires soon: ") don't count */
  for (const m of block.matchAll(/(?:^|,|\{)\s*([a-z][a-z0-9_]*): '/gm)) keys.add(m[1]);
  return keys;
}

const zh = blockKeys('const zh = {', '} as const;');
const en = blockKeys('const en: Record<I18nKey, string> = {', '};');

const missingInEn = [...zh].filter((k) => !en.has(k));
const missingInZh = [...en].filter((k) => !zh.has(k));

console.log(`zh keys: ${zh.size}, en keys: ${en.size}`);
if (missingInEn.length || missingInZh.length) {
  if (missingInEn.length) console.error('missing in en:', missingInEn.join(', '));
  if (missingInZh.length) console.error('missing in zh:', missingInZh.join(', '));
  process.exit(1);
}
console.log('i18n parity OK: 0 missing');
