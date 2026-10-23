/** Tools-page dictionaries, assembled from the per-feature clusters below.
 * scripts/check-i18n.mjs resolves these named imports and spreads. */
import { toolsTrialZh, toolsTrialEn } from './i18n-tools-trial';
import { toolsSettingsZh, toolsSettingsEn } from './i18n-tools-settings';
import { toolsDnsZh, toolsDnsEn } from './i18n-tools-dns';
import { toolsRoutingZh, toolsRoutingEn } from './i18n-tools-routing';

export const toolsZh = {
  ...toolsTrialZh,
  ...toolsSettingsZh,
  ...toolsDnsZh,
  ...toolsRoutingZh,
};

export const toolsEn: Record<keyof typeof toolsZh, string> = {
  ...toolsTrialEn,
  ...toolsSettingsEn,
  ...toolsDnsEn,
  ...toolsRoutingEn,
};

export type ToolsKey = keyof typeof toolsZh;
