#!/usr/bin/env node
/* The seed is fixed: generate its tokens at development time rather than
 * run Material's palette solver before the first frame on every phone. */
import { readFileSync, writeFileSync } from 'node:fs';
import { themeFromSourceColor } from '../node_modules/@material/material-color-utilities/utils/theme_utils.js';
import { argbFromHex, hexFromArgb } from '../node_modules/@material/material-color-utilities/utils/string_utils.js';

const seed = '#E0632F';
const theme = themeFromSourceColor(argbFromHex(seed));
const schemes = Object.fromEntries(['dark', 'light'].map((mode) => [mode,
  Object.fromEntries(Object.entries(theme.schemes[mode].toJSON()).map(([key, value]) => [
    '--md-sys-color-' + key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(), hexFromArgb(value),
  ])),
]));
const target = new URL('../src/theme.generated.ts', import.meta.url);
const output = `/* Generated from ${seed} by scripts/generate-theme.mjs; do not edit. */\nexport const THEME_TOKENS = ${JSON.stringify(schemes, null, 2)} as const;\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('Theme tokens changed; run pnpm theme:generate');
  console.log('Theme tokens match the fixed Material palette.');
} else {
  writeFileSync(target, output);
}
