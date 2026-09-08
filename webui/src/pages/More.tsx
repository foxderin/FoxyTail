/* More — overflow page linking the eight secondary routes. */
import { For, type JSX } from 'solid-js';
import { t, type I18nKey } from '../i18n';
import { MdIcon, type IconName } from '../icons';
import { Card } from '../components/Basics';

const LINKS: { route: string; labelKey: I18nKey; icon: IconName }[] = [
  { route: 'tunnel', labelKey: 'more_tunnel', icon: 'router' },
  { route: 'routing', labelKey: 'more_routing', icon: 'alt_route' },
  { route: 'account', labelKey: 'more_account', icon: 'person' },
  { route: 'serve', labelKey: 'more_serve', icon: 'dns' },
  { route: 'files', labelKey: 'more_files', icon: 'folder' },
  { route: 'logs', labelKey: 'more_logs', icon: 'article' },
  { route: 'settings', labelKey: 'more_settings', icon: 'settings' },
  { route: 'diag', labelKey: 'more_diag', icon: 'bug_report' },
];

export default function More(): JSX.Element {
  return (
    <Card title={t('more_title')} icon="more_horiz">
      <For each={LINKS}>
        {(item) => (
          <a class="more-row" href={'#/' + item.route}>
            <MdIcon name={item.icon} size={22} />
            <span class="main">{t(item.labelKey)}</span>
            <MdIcon name="chevron_right" size={20} />
          </a>
        )}
      </For>
    </Card>
  );
}
