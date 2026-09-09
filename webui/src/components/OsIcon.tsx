import type { JSX } from 'solid-js';
import { t } from '../i18n';
import { MdIcon, type IconName } from '../icons';

/** Official Material Symbols bundled locally with the rest of the interface. */
export function OsIcon(props: { os: string }): JSX.Element {
  const os = () => props.os.trim().toLowerCase();
  const icon = (): IconName => {
    const name = os();
    if (name.includes('android')) return 'android';
    if (name.includes('windows')) return 'desktop_windows';
    if (
      ['ios', 'ipados', 'iphone', 'ipad'].some((value) => name.includes(value))
    )
      return 'mobile_2';
    if (name.includes('mac') || name.includes('darwin')) return 'laptop_mac';
    if (name.includes('linux') || name.includes('bsd')) return 'terminal';
    return 'devices';
  };
  const label = () => (os() && os() !== '-' ? props.os : t('net_unknown'));
  return (
    <span
      class="network-os-icon"
      title={label()}
      role="img"
      aria-label={label()}
    >
      <MdIcon name={icon()} size={24} />
    </span>
  );
}
