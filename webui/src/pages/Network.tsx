/* Network hub: run-mode picker plus links into the detail tools. */
import { createSignal, For, onMount, type JSX } from 'solid-js';
import { createApiScope } from '../api';
import { t } from '../i18n';
import { exitNodeLabel } from '../service';
import { ModePicker } from '../components/ServiceControls';
import { Card } from '../components/Basics';
import { MdIcon, type IconName } from '../icons';
import type { RouteName } from '../navigation';
import './tools.css';

interface TunSummary { ifaceUp?: boolean }

export default function Network(): JSX.Element {
  const scope = createApiScope();
  const [tun, setTun] = createSignal<TunSummary | null>(null);
  onMount(() => {
    void scope.api('tun').then(res => {
      if (!res.cancelled && res.ok) setTun(res as TunSummary);
    });
  });
  const links = (): { route: RouteName; icon: IconName; label: string; desc: string }[] => [
    { route: 'exit', icon: 'logout', label: t('dash_exitnode'), desc: exitNodeLabel() },
    { route: 'tunnel', icon: 'router', label: t('tun_title'), desc: tun() ? `tailscale0 · ${t(tun()!.ifaceUp ? 'tun_up' : 'tun_down')}` : t('tools_tunnel_desc') },
    { route: 'routing', icon: 'alt_route', label: t('route_title'), desc: t('tools_routing_desc') },
    { route: 'serve', icon: 'dns', label: t('serve_title'), desc: t('tools_serve_desc') },
    { route: 'traffic', icon: 'monitoring', label: t('traffic_title'), desc: t('tools_traffic_desc') },
  ];
  return (
    <div class="tools-page">
      <Card title={t('mode_card_title')} icon="tune">
        <p class="tool-hint">{t('mode_card_desc')}</p>
        <ModePicker />
      </Card>
      <div class="tool-links">
        <For each={links()}>
          {(item) => (
            <a class="tool-link" href={'#/' + item.route}>
              <span class="tool-link-icon">
                <MdIcon name={item.icon} size={22} />
              </span>
              <span class="tool-link-copy">
                <span class="tool-link-name">{item.label}</span>
                <span class="tool-link-desc">{item.desc}</span>
              </span>
              <MdIcon name="chevron_right" size={19} />
            </a>
          )}
        </For>
      </div>
    </div>
  );
}
