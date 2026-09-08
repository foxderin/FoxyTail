/*
 * Material Symbols (outlined, 400) inlined at build time via ?raw imports —
 * zero runtime requests. MdIcon normalizes size and inherits currentColor.
 */
import type { JSX } from 'solid-js';

import dashboard from '@material-symbols/svg-400/outlined/dashboard.svg?raw';
import group from '@material-symbols/svg-400/outlined/group.svg?raw';
import logoutIcon from '@material-symbols/svg-400/outlined/logout.svg?raw';
import person from '@material-symbols/svg-400/outlined/person.svg?raw';
import router from '@material-symbols/svg-400/outlined/router.svg?raw';
import altRoute from '@material-symbols/svg-400/outlined/alt_route.svg?raw';
import monitoring from '@material-symbols/svg-400/outlined/monitoring.svg?raw';
import dns from '@material-symbols/svg-400/outlined/dns.svg?raw';
import folder from '@material-symbols/svg-400/outlined/folder.svg?raw';
import article from '@material-symbols/svg-400/outlined/article.svg?raw';
import settings from '@material-symbols/svg-400/outlined/settings.svg?raw';
import bugReport from '@material-symbols/svg-400/outlined/bug_report.svg?raw';
import moreHoriz from '@material-symbols/svg-400/outlined/more_horiz.svg?raw';
import wifi from '@material-symbols/svg-400/outlined/wifi.svg?raw';
import vpnKey from '@material-symbols/svg-400/outlined/vpn_key.svg?raw';
import login from '@material-symbols/svg-400/outlined/login.svg?raw';
import refresh from '@material-symbols/svg-400/outlined/refresh.svg?raw';
import playArrow from '@material-symbols/svg-400/outlined/play_arrow.svg?raw';
import stop from '@material-symbols/svg-400/outlined/stop.svg?raw';
import restartAlt from '@material-symbols/svg-400/outlined/restart_alt.svg?raw';
import checkCircle from '@material-symbols/svg-400/outlined/check_circle.svg?raw';
import errorIcon from '@material-symbols/svg-400/outlined/error.svg?raw';
import warning from '@material-symbols/svg-400/outlined/warning.svg?raw';
import info from '@material-symbols/svg-400/outlined/info.svg?raw';
import contentCopy from '@material-symbols/svg-400/outlined/content_copy.svg?raw';
import openInNew from '@material-symbols/svg-400/outlined/open_in_new.svg?raw';
import add from '@material-symbols/svg-400/outlined/add.svg?raw';
import deleteIcon from '@material-symbols/svg-400/outlined/delete.svg?raw';
import close from '@material-symbols/svg-400/outlined/close.svg?raw';
import search from '@material-symbols/svg-400/outlined/search.svg?raw';
import darkMode from '@material-symbols/svg-400/outlined/dark_mode.svg?raw';
import lightMode from '@material-symbols/svg-400/outlined/light_mode.svg?raw';
import translate from '@material-symbols/svg-400/outlined/translate.svg?raw';
import backup from '@material-symbols/svg-400/outlined/backup.svg?raw';
import speed from '@material-symbols/svg-400/outlined/speed.svg?raw';
import networkCheck from '@material-symbols/svg-400/outlined/network_check.svg?raw';
import chevronRight from '@material-symbols/svg-400/outlined/chevron_right.svg?raw';
import send from '@material-symbols/svg-400/outlined/send.svg?raw';
import download from '@material-symbols/svg-400/outlined/download.svg?raw';
import sync from '@material-symbols/svg-400/outlined/sync.svg?raw';
import language from '@material-symbols/svg-400/outlined/language.svg?raw';

const ICONS = {
  dashboard,
  group,
  logout: logoutIcon,
  person,
  router,
  alt_route: altRoute,
  monitoring,
  dns,
  folder,
  article,
  settings,
  bug_report: bugReport,
  more_horiz: moreHoriz,
  wifi,
  vpn_key: vpnKey,
  login,
  refresh,
  play_arrow: playArrow,
  stop,
  restart_alt: restartAlt,
  check_circle: checkCircle,
  error: errorIcon,
  warning,
  info,
  content_copy: contentCopy,
  open_in_new: openInNew,
  add,
  delete: deleteIcon,
  close,
  search,
  dark_mode: darkMode,
  light_mode: lightMode,
  translate,
  backup,
  speed,
  network_check: networkCheck,
  chevron_right: chevronRight,
  send,
  download,
  sync,
  language,
} as const;

export type IconName = keyof typeof ICONS;

export function iconSvg(name: IconName): string {
  return ICONS[name];
}

export function MdIcon(props: { name: IconName; size?: number; class?: string }): JSX.Element {
  const size = () => props.size ?? 24;
  return (
    <span
      class={'md-icon' + (props.class ? ' ' + props.class : '')}
      style={{ width: `${size()}px`, height: `${size()}px` }}
      aria-hidden="true"
      /* Build-time constant SVG strings from the icon package — never
       * user input, so innerHTML is safe here. */
      innerHTML={ICONS[props.name]}
    />
  );
}
