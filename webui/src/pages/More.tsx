import { For, type JSX } from 'solid-js';
import { t, type I18nKey } from '../i18n';
import type { ToolsKey } from '../i18n-tools';
import { MdIcon } from '../icons';
import { routeIcon, type RouteName } from '../navigation';
import './tools.css';

type Tool = { route: RouteName; label: I18nKey; description: ToolsKey };
const GROUPS: { title: ToolsKey; tools: Tool[] }[] = [
  {
    title: 'tools_network',
    tools: [
      { route: 'tunnel', label: 'more_tunnel', description: 'tools_tunnel_desc' },
      { route: 'routing', label: 'more_routing', description: 'tools_routing_desc' },
      { route: 'serve', label: 'more_serve', description: 'tools_serve_desc' },
    ],
  },
  {
    title: 'tools_device',
    tools: [
      { route: 'account', label: 'more_account', description: 'tools_account_desc' },
      { route: 'files', label: 'more_files', description: 'tools_files_desc' },
    ],
  },
  {
    title: 'tools_maintenance',
    tools: [
      { route: 'logs', label: 'more_logs', description: 'tools_logs_desc' },
      { route: 'diag', label: 'more_diag', description: 'tools_diag_desc' },
      { route: 'settings', label: 'more_settings', description: 'tools_settings_desc' },
    ],
  },
];
export default function More(): JSX.Element {
  return (
    <div class="tools-page">
      <For each={GROUPS}>
        {(group) => (
          <section class="tool-group">
            <div class="tool-group-heading">
              <h2>{t(group.title)}</h2>
            </div>
            <div class="tool-links">
              <For each={group.tools}>
                {(item) => (
                  <a class="tool-link" href={'#/' + item.route}>
                    <span class="tool-link-icon">
                      <MdIcon name={routeIcon(item.route)} size={22} />
                    </span>
                    <span class="tool-link-copy">
                      <span class="tool-link-name">{t(item.label)}</span>
                      <span class="tool-link-desc">{t(item.description)}</span>
                    </span>
                    <MdIcon name="chevron_right" size={19} />
                  </a>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </div>
  );
}
