#!/usr/bin/env node
// `pnpm smoke` builds first; an optional argv[2] selects an external smoke bundle.
import { failures, checks, window } from './smoke-fixture.mjs';
import { checkCore } from './smoke-core.mjs';
import { checkPages } from './smoke-pages.mjs';
import { checkService, checkAuthentication } from './smoke-service.mjs';
import { checkRouting } from './smoke-routing.mjs';
import { checkSettings } from './smoke-settings.mjs';
import { checkContextRules } from './smoke-context.mjs';
import { checkDiagnostics } from './smoke-diagnostics.mjs';
import { checkRecovery } from './smoke-recovery.mjs';
import { checkPower } from './smoke-power.mjs';

// Reuse one app so navigation, pending work and stale replies cross real page lifetimes.
await checkCore();
await checkPages();
const serviceStates = await checkService();
await checkRouting();
await checkAuthentication(serviceStates);
await checkSettings();
await checkContextRules();
await checkDiagnostics();
await checkRecovery();
await checkPower();
window.close();

if (failures.length) {
  console.error('SMOKE FAILURES:\n' + failures.map(failure => ' - ' + failure).join('\n'));
  process.exit(1);
}
console.log(`SMOKE OK (${checks} assertions)`);
process.exit(0);
