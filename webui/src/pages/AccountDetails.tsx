/* Read-only device facts from the existing, account-fenced status snapshot.
 * No prefs/state file, auth key, login URL or private key is read here. */
import { For, Show, type JSX } from 'solid-js';
import { Card, SkeletonRows } from '../components/Basics';
import { LoadGate } from '../components/LoadGate';
import { Button } from '../components/ui';
import { status, statusError, statusLoading, refreshStatus } from '../state';
import { t } from '../i18n';
import { copyWithToast } from '../clipboard';
import './account.css';

export default function AccountDetails(): JSX.Element {
  const self = () => !statusError() ? status()?.self : null;
  const expiry = () => {
    const value = status()?.keyExpiry;
    if (!value || !Number.isFinite(Date.parse(value))) return t('acc_not_reported');
    return new Date(value).toLocaleString();
  };
  return <Card title={t('acc_device_details')} icon="info"
    description={t('acc_device_details_hint')}
    actions={<Button variant="text" busy={statusLoading()} onClick={() => void refreshStatus({ afterCurrent: true })}>{t('tools_refresh')}</Button>}>
    <LoadGate ready={!!status()} error={statusError()} onRetry={() => void refreshStatus({ afterCurrent: true })}
      skeleton={<SkeletonRows rows={4} />} hasContent={!!status() && !statusError()}>
      <dl class="account-facts" data-testid="account-device-details">
        <div><dt>{t('acc_backend')}</dt><dd>{status()?.backend || t('acc_not_reported')}</dd></div>
        <Show when={self()?.id}>
          <div><dt>{t('acc_device_name')}</dt><dd>{self()?.hostname || t('acc_not_reported')}</dd></div>
          <div><dt>{t('acc_device_id')}</dt><dd class="mono">{self()?.id}</dd></div>
          <div><dt>{t('acc_addresses')}</dt><dd>
            <For each={self()?.ips || []}>{ip => <div class="account-address"><code>{ip}</code>
              <Button variant="text" aria-label={t('copy') + ' ' + ip} onClick={() => copyWithToast(ip)}>{t('copy')}</Button></div>}</For>
            <Show when={!self()?.ips?.length}>{t('acc_not_reported')}</Show>
          </dd></div>
          <div><dt>MagicDNS</dt><dd>{typeof status()?.magicDns === 'boolean' ? t(status()?.magicDns ? 'net_enabled' : 'net_disabled') : t('acc_not_reported')}</dd></div>
          <div><dt>{t('acc_key_expiry')}</dt><dd>{expiry()}</dd></div>
        </Show>
      </dl>
    </LoadGate>
  </Card>;
}
