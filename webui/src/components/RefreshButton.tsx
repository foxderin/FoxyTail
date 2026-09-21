/* Toolbar refresh button: outlined, with the icon spinning while a read runs. */
import { type JSX } from 'solid-js';
import { t } from '../i18n';
import { MdIcon } from '../icons';
import { Button } from './ui';

export function RefreshButton(props: { loading: boolean; onClick: () => void }): JSX.Element {
  return (
    <Button variant="outlined" disabled={props.loading} onClick={props.onClick}>
      <MdIcon
        name="refresh"
        size={18}
        class={props.loading ? 'network-refreshing' : ''}
      />
      {props.loading ? t('loading') : t('net_refresh')}
    </Button>
  );
}
